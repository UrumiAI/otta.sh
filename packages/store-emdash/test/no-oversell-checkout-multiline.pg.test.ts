/**
 * THE batched-checkout acceptance gate, on the document adapter — the
 * store-postgres suite of the same name, re-pointed at `EmdashOrderStore` over
 * `EmdashCartStore` and `EmdashInventoryStore`. Postgres only: better-sqlite3
 * serializes writes in one process, so it verifies the shape and never the
 * contention.
 *
 * It is the gate the single-line sibling cannot be: with THREE distinct-sku lines
 * per cart, the checkout's `adoptMany` and the settle's `commitMany` each carry
 * N > 1 ids, and ADR-0019 §7.4 is explicit that cross-SKU work is N per-SKU writes
 * rather than one atom. A cart can win one sku and lose another and so never fully
 * check out, which is why `committed == M × lines` is NOT a valid assertion: the
 * gate computes the FULL winners (carts that won every line) and asserts
 * `committed == fullWinners × lines`, each sku drawn down to 0, and that no paid
 * order HALF-commits.
 *
 * The M/N/loop numbers, the three skus and the original assertions are unchanged.
 * What is added is the intent half the document model makes checkable: every paid
 * order's commit intent names exactly its own three reservations, and the sweeper's
 * completion pass loses none of them.
 */
import {
	addLine,
	createCart,
	createOrderFromCart,
	currency,
	idempotencyKey,
	type Order,
	settleOrder,
	sku as brandSku,
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

const M = 8; // per-sku stock
const N = 10; // racing carts
const LOOPS = 6;
const LINES = 3; // distinct skus per cart
const USD = currency("USD");

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

/** The product id this gate seeds beside each sku. */
function productFor(stockKeeping: string): string {
	return `p-${stockKeeping}`;
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

const PG_SUITE = PG_ENABLED
	? "no oversell through MULTI-LINE checkout [postgres]"
	: "no oversell through MULTI-LINE checkout [postgres] — skipped: PG_CONNECTION_STRING is not set";

describe.skipIf(!PG_ENABLED)(PG_SUITE, () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;

	beforeAll(async () => {
		const db = await makePgStorage(ORDER_LAYOUT, N * LINES + 4);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	test(`racing multi-line carts: adoptMany/commitMany with ${String(LINES)} ids never oversell or half-commit`, async () => {
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
		const fullWinnersPerLoop: number[] = [];
		let paidSoFar = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			// Fresh skus per loop: each race is independent, and no loop has to empty
			// the storage table.
			const skus = Array.from({ length: LINES }, (_u, j) => `SKU-ML-${String(loop)}-${String(j)}`);
			for (const stockKeeping of skus) {
				await h.seedPhysical({
					productId: productFor(stockKeeping),
					sku: stockKeeping,
					priceCents: 100,
					title: `Widget ${stockKeeping}`,
					onHand: M,
				});
			}

			// N carts, each racing to reserve one physical line per sku. Within a cart
			// the adds race each other too, and across carts they race the same units —
			// so a cart can win some skus and lose others.
			const carts = await Promise.all(
				Array.from({ length: N }, async (_unused, i) => {
					const cartId = await createCart(h.cartDeps, USD);
					const results = await Promise.all(
						skus.map((stockKeeping, j) =>
							addLine(
								h.cartDeps,
								cartId,
								brandSku(stockKeeping),
								productFor(stockKeeping),
								1,
								idempotencyKey(`add-${String(loop)}-${String(i)}-${String(j)}`),
								"physical",
							),
						),
					);
					return { cartId, i, wonAll: results.every((r) => r.ok) };
				}),
			);

			// Every sku is contended by all N > M carts, so each is fully drawn down.
			for (const stockKeeping of skus) {
				expect(await h.onHand(stockKeeping), `loop ${String(loop)}: onHand after reserve`).toBe(0);
			}

			// Only FULL winners can check out completely. They race checkout
			// (`adoptMany`, LINES ids) → pay → settle (`commitMany`, LINES ids).
			const fullWinners = carts.filter((c) => c.wonAll);
			expect(fullWinners.length, `loop ${String(loop)}: full winners exist`).toBeGreaterThan(0);

			const orders = await Promise.all(
				fullWinners.map(async ({ cartId, i }) => {
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
				const ids = reservationIdsOf(stored);
				expect(ids, `loop ${String(loop)}: order ${order.id} lines`).toHaveLength(LINES);
				// The commit intent rode the paid flip and names this order's own holds.
				expect(stored.holdsCommitted?.reservationIds, `loop ${String(loop)}: intent`).toEqual(ids);
				expect(
					await h.store.completeHoldCommit(order.id),
					`loop ${String(loop)}: completion`,
				).toEqual({ completed: true, lost: [] });
				// NO HALF-COMMIT: every line of every paid order is committed. The count
				// that BOUNDS this is the table-wide one below.
				for (const id of ids) {
					expect(await h.reservationState(id), `loop ${String(loop)}: ${id}`).toBe("committed");
				}
			}
			expect(paid, `loop ${String(loop)}: paid orders`).toBe(fullWinners.length);
			// Committed stock stays gone (never resold): each sku still at 0.
			for (const stockKeeping of skus) {
				expect(await h.onHand(stockKeeping), `loop ${String(loop)}: final onHand`).toBe(0);
			}

			// THE UPPER BOUND, counted table-wide rather than derived from the winners'
			// own documents — the half a per-order iteration cannot supply.
			paidSoFar += fullWinners.length;
			expect(
				await countAll(orderDocs, { state: "paid" }, () => true),
				`loop ${String(loop)}: paid orders store-wide`,
			).toBe(paidSoFar);
			expect(
				await countAll(reservationIndex, {}, (doc) => doc.terminalState === "committed"),
				`loop ${String(loop)}: committed reservations store-wide`,
			).toBe(paidSoFar * LINES);
			// Every COMMITTED hold is pruned out of its aggregate. Unlike the
			// single-line gate, "no live holds at all" would be wrong here: a cart that
			// won some skus and lost others never checks out, so its winning lines' holds
			// legitimately stay live and cart-`held`. What must never survive is a hold
			// belonging to a PAID order — that is the live-hold-over-spent-units state
			// every expiry path would try to return.
			const committedIds = new Set<string>(
				orders.flatMap((order) =>
					order.lines
						.map((line) => line.reservationId)
						.filter((id): id is NonNullable<typeof id> => id !== null),
				),
			);
			for (const stockKeeping of skus) {
				for (const hold of Object.values(await holdsOf(h.inventoryDocs, stockKeeping))) {
					expect(
						committedIds.has(hold.reservationId),
						`loop ${String(loop)}: ${stockKeeping} still holds committed ${hold.reservationId}`,
					).toBe(false);
					// And a surviving hold is a CART hold, never one an order adopted.
					expect(hold.state, `loop ${String(loop)}: surviving hold state`).toBe("held");
				}
			}
			fullWinnersPerLoop.push(fullWinners.length);
		}

		console.info(
			`[no-oversell-checkout-multiline] loops=${String(LOOPS)} lines=${String(LINES)} ` +
				`fullWinnersPerLoop=${fullWinnersPerLoop.join(",")} ` +
				`maxCasAttempts=${String(maxAttempts)}/${String(CAS_MAX_ATTEMPTS)}`,
		);
		expect(maxAttempts).toBeLessThan(CAS_MAX_ATTEMPTS);
	}, 300_000);
});
