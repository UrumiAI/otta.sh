/**
 * THE checkout acceptance gate, on the document adapter. `@otta-sh/store-postgres`
 * is gone; this is the pg-tier coverage now, re-pointed at `EmdashOrderStore` over
 * `EmdashCartStore` and
 * `EmdashInventoryStore`. Postgres only: better-sqlite3 serializes writes in one
 * process, so it verifies the shape and never the contention.
 *
 * N buyers race for the last M units, and the guarantee is extended across
 * CHECKOUT and COMMIT: exactly M orders reach paid, exactly M reservations end
 * `committed`, the losers never got a reservation, and the final count is 0 —
 * committed stock stays gone and is never resold.
 *
 * The M/N/loop numbers and the original assertions are unchanged. Three assertions
 * are ADDED, because the document model makes them checkable:
 *
 * - every paid order carries a COMMIT INTENT naming exactly its own reservations,
 *   recorded by the same write as the paid flip;
 * - the sweeper's completion pass (`completeHoldCommit`) finds nothing lost on the
 *   happy path — the singular per-id commits are all benign no-ops after the
 *   batch — and closes the intent;
 * - the audit event and the outbox entry that rode each flip are there exactly
 *   once.
 *
 * A fresh sku per loop, rather than truncating between loops: each race is
 * independent, and nothing has to empty the storage table (which is also what
 * keeps every loop on the same revision trigger).
 *
 * The pool is sized so each of the N callers can hold its OWN connection; a pool
 * narrower than the crowd serializes the writers and weakens the race, which is
 * why this file builds its own storage instead of taking the shared one.
 */
import {
	addLine,
	createCart,
	createOrderFromCart,
	currency,
	idempotencyKey,
	type Order,
	settleOrder,
	sku,
} from "@otta-sh/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	CAS_MAX_ATTEMPTS,
	collectionOf,
	normalizeOrderDoc,
	ORDERS_COLLECTION,
	RESERVATION_INDEX_COLLECTION,
	type HoldEntry,
	type InventoryDoc,
	type OrderDoc,
	type ReservationIndexDoc,
	type StorageAccess,
	type StorageCollection,
	type WhereClause,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

/**
 * Count documents across a WHOLE collection, paging past the host's 100-row clamp.
 *
 * The originals counted table-wide (`SELECT count(*) FROM orders WHERE state='paid'`,
 * `… FROM reservations WHERE state='committed'`), and that is the half of the gate
 * that supplies its UPPER bound: a count derived by iterating the winners' own
 * documents can only ever confirm what those documents already say, so an extra paid
 * order or an extra committed reservation ANYWHERE would go unnoticed. This restores
 * it over the raw collection handles.
 */
async function countAll<T>(
	collection: StorageCollection<T>,
	where: WhereClause,
	keep: (doc: T) => boolean,
): Promise<number> {
	let found = 0;
	let cursor: string | undefined;
	for (let page = 0; page < 1000; page++) {
		const result = await collection.query({ where, limit: 100, cursor });
		for (const { data } of result.items) if (keep(data)) found++;
		if (!result.hasMore || result.cursor === undefined) return found;
		cursor = result.cursor;
	}
	throw new Error("countAll ran out of pages");
}

/**
 * Every reservation id on a stored order, with the premise ENFORCED rather than
 * defaulted: a `?? ""` would let an order whose line lost its reservation sail past
 * every assertion made about that reservation.
 */
function reservationIdsOf(doc: { items: readonly { reservationId: string | null }[] }): string[] {
	return doc.items.map((item) => {
		if (item.reservationId === null) {
			throw new Error("a physical order line was expected to carry a reservation id");
		}
		return item.reservationId;
	});
}

/** The live holds on a sku's aggregate — a hard read; an absent document is a fault. */
async function holdsOf(
	inventoryDocs: StorageCollection<InventoryDoc>,
	stockKeeping: string,
): Promise<Record<string, HoldEntry>> {
	const doc = await inventoryDocs.get(stockKeeping);
	if (doc === null) throw new Error(`inventory document for ${stockKeeping} is missing`);
	return doc.holds ?? {};
}

/** Pay an order through the real gateway + settle use-case. */
async function settleCheckout(h: OrderHarness, order: Order): Promise<void> {
	await settleOrder(
		h.settleDeps,
		h.stripeGateway,
		h.stripeGateway.webhook({
			outcome: "succeeded",
			orderId: order.id,
			providerRef: `pi-${order.id}`,
			amount: order.totals.total,
			currency: "USD",
			dedupeKey: `evt-${order.id}`,
		}),
	);
}

const M = 5;
const N = 40;
const LOOPS = 8;
const USD = currency("USD");

const PG_SUITE = PG_ENABLED
	? "no oversell through checkout [postgres]"
	: "no oversell through checkout [postgres] — skipped: PG_CONNECTION_STRING is not set";

describe.skipIf(!PG_ENABLED)(PG_SUITE, () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;

	beforeAll(async () => {
		const db = await makePgStorage(ORDER_LAYOUT, N + 4);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	test(`concurrent checkout of the last ${String(M)} units: exactly ${String(M)} orders reach paid+commit`, async () => {
		let maxAttempts = 0;
		const h: OrderHarness = makeOrderHarness(storage, {
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		});
		const orderDocs = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
		const reservationIndex = collectionOf<ReservationIndexDoc>(
			storage,
			RESERVATION_INDEX_COLLECTION,
		);
		const paidPerLoop: number[] = [];

		for (let loop = 0; loop < LOOPS; loop++) {
			// A fresh sku per loop; `seedPhysical`'s stock write is create-if-absent, so
			// it seeds this loop's units and could never clobber a live count.
			const stockKeeping = `SKU-CHECKOUT-RACE-${String(loop)}`;
			await h.seedPhysical({
				productId: `p-${String(loop)}`,
				sku: stockKeeping,
				priceCents: 100,
				title: "Widget",
				onHand: M,
			});

			// N buyers, each their own cart, race the same M units at add-to-cart.
			const cartIds = await Promise.all(
				Array.from({ length: N }, () => createCart(h.cartDeps, USD)),
			);
			const added = await Promise.all(
				cartIds.map((cartId, i) =>
					addLine(
						h.cartDeps,
						cartId,
						sku(stockKeeping),
						`p-${String(loop)}`,
						1,
						idempotencyKey(`add-${String(loop)}-${String(i)}`),
						"physical",
					).then((r) => ({ cartId, i, r })),
				),
			);
			const winners = added.filter((x) => x.r.ok);
			expect(winners, `loop ${String(loop)}: reservations held`).toHaveLength(M);

			// The winners concurrently check out → pay → commit.
			const orders = await Promise.all(
				winners.map(async ({ cartId, i }) => {
					const created = await createOrderFromCart(h.createDeps, {
						cartId,
						idempotencyKey: idempotencyKey(`ord-${String(loop)}-${String(i)}`),
						buyerRef: `b${String(i)}@example.com`,
						paymentMethod: "stripe",
					});
					if (!created.ok) throw new Error(`checkout failed: ${created.reason}`);
					return created.order;
				}),
			);
			await Promise.all(orders.map((order) => settleCheckout(h, order)));

			let paid = 0;
			for (const order of orders) {
				const doc = await h.orders.get(order.id);
				if (doc === null) throw new Error(`loop ${String(loop)}: missing order document`);
				const stored = normalizeOrderDoc(doc);
				if (stored.state === "paid") paid++;
				// The flip's three co-written facts, each exactly once.
				expect(
					stored.events.map((e) => e.toState),
					`loop ${String(loop)}: audit`,
				).toEqual(["paid"]);
				expect(
					stored.emailOutbox.map((e) => e.toState),
					`loop ${String(loop)}: outbox`,
				).toEqual(["paid"]);
				// The commit intent rode that same write and names this order's own holds.
				const ids = reservationIdsOf(stored);
				expect(stored.holdsCommitted?.reservationIds, `loop ${String(loop)}: intent`).toEqual(ids);
				// The sweeper's completion pass: benign after the batch, and it closes the
				// intent. `lost` empty is the "no paid order left un-committed" half.
				expect(
					await h.store.completeHoldCommit(order.id),
					`loop ${String(loop)}: completion`,
				).toEqual({ completed: true, lost: [] });
				for (const id of ids) {
					expect(await h.reservationState(id), `loop ${String(loop)}: ${id}`).toBe("committed");
				}
			}
			// `paid` is a per-order tally kept only as the loop's own read-back; the
			// gate's UPPER bound is the table-wide count below, which is the half a
			// per-order iteration cannot supply.
			expect(paid, `loop ${String(loop)}: paid orders`).toBe(M);
			expect(await h.onHand(stockKeeping), `loop ${String(loop)}: final onHand`).toBe(0);

			// THE UPPER BOUND, counted table-wide rather than derived from the winners'
			// own documents: every loop adds exactly M paid orders and M committed
			// reservations to the whole store, so an extra one ANYWHERE fails here.
			expect(
				await countAll(orderDocs, { state: "paid" }, () => true),
				`loop ${String(loop)}: paid orders store-wide`,
			).toBe(M * (loop + 1));
			expect(
				await countAll(reservationIndex, {}, (doc) => doc.terminalState === "committed"),
				`loop ${String(loop)}: committed reservations store-wide`,
			).toBe(M * (loop + 1));
			// And the aggregate itself holds nothing live: every committed hold is
			// pruned, so no expiry path can ever return spent units.
			expect(
				Object.keys(await holdsOf(h.inventoryDocs, stockKeeping)),
				`loop ${String(loop)}: live holds on ${stockKeeping}`,
			).toHaveLength(0);
			paidPerLoop.push(paid);
		}

		console.info(
			`[no-oversell-checkout] loops=${String(LOOPS)} paidPerLoop=${paidPerLoop.join(",")} ` +
				`maxCasAttempts=${String(maxAttempts)}/${String(CAS_MAX_ATTEMPTS)}`,
		);
		expect(paidPerLoop).toEqual(Array.from({ length: LOOPS }, () => M));
		expect(maxAttempts).toBeLessThan(CAS_MAX_ATTEMPTS);
	}, 300_000);
});
