/**
 * ONE receipt settles ONE order — under real concurrency (issue #448).
 *
 * The sequential cases (`settle-order.test.ts` in the domain, and this package's
 * `payment-event-store.dialects.test.ts`) prove the receipt binding when the
 * second order arrives AFTER the first has bound the dedupe key. This file races
 * them: K same-priced orders each submit the SAME receipt (one dedupe key, one
 * provider ref) at once, through the real `settleOrder` over the document-backed
 * `EmdashPaymentEventStore` and `EmdashOrderStore`. Exactly one binds and reaches
 * `paid`; every other one is refused `RECEIPT_REBOUND`, stays `pending`, and has a
 * `RECEIPT_REBOUND` anomaly recorded against it naming the winner.
 *
 * Postgres-required: better-sqlite3 serializes writes in-process, so it can verify
 * the statements but never lose the race. The race repeats LOOPS times with a fresh
 * receipt and fresh orders each loop; nothing asserts on timing, so a slow shared
 * runner only makes a loop slower, never a flake.
 *
 * The pool is sized so each racer holds its own connection — a narrower pool would
 * serialize the writers and weaken the race.
 */
import {
	createOrderFromCart,
	idempotencyKey,
	type Order,
	settleOrder,
} from "@urumi.ai/otta-domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	collectionOf,
	EmdashPaymentEventStore,
	normalizeOrderDoc,
	PAYMENT_ANOMALIES_COLLECTION,
	PAYMENT_EVENTS_COLLECTION,
	PAYMENT_REFS_COLLECTION,
	type PaymentAnomalyDoc,
	type PaymentEventDoc,
	type PaymentRefDoc,
	type StorageAccess,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

/** Orders racing one receipt per loop. */
const K = 4;
const LOOPS = 15;

type SettleOutcome =
	| { kind: "settled"; result: Awaited<ReturnType<typeof settleOrder>> }
	| { kind: "threw"; err: unknown };

/** Settle, capturing a throw as data so one racer's failure cannot hide the rest. */
async function settleCaptured(call: Promise<Awaited<ReturnType<typeof settleOrder>>>) {
	try {
		return { kind: "settled", result: await call } satisfies SettleOutcome;
	} catch (err: unknown) {
		return { kind: "threw", err } satisfies SettleOutcome;
	}
}

const PG_SUITE = PG_ENABLED
	? "receipt rebound race [postgres]"
	: "receipt rebound race [postgres] — skipped: PG_CONNECTION_STRING is not set";

describe.skipIf(!PG_ENABLED)(PG_SUITE, () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;

	beforeAll(async () => {
		const db = await makePgStorage({ ...ORDER_LAYOUT, ...MISC_LAYOUT }, K + 2);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	test(`${String(K)} orders racing ONE receipt: exactly one binds, the rest are refused with an anomaly`, async () => {
		const h: OrderHarness = makeOrderHarness(storage);
		// The real document-backed payment-event store, not the harness's in-memory
		// fake: its create-if-absent on the dedupe key is what the race contends.
		const settleDeps = {
			...h.settleDeps,
			paymentEventStore: new EmdashPaymentEventStore({ storage }),
		};
		const paymentRefs = collectionOf<PaymentRefDoc>(storage, PAYMENT_REFS_COLLECTION);
		const anomalies = collectionOf<PaymentAnomalyDoc>(storage, PAYMENT_ANOMALIES_COLLECTION);
		async function listAnomalies(): Promise<PaymentAnomalyDoc[]> {
			const found: PaymentAnomalyDoc[] = [];
			let cursor: string | undefined;
			do {
				const page = await anomalies.query({ limit: 100, cursor });
				for (const { data } of page.items) found.push(data);
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor !== undefined);
			return found;
		}

		// One digital product, so every racing order carries the same total — the
		// amount check alone could never tell them apart.
		await h.seedDigital({ productId: "d-race", sku: "DIG-RACE", priceCents: 900, title: "Ebook" });

		for (let loop = 0; loop < LOOPS; loop++) {
			const tag = `loop ${String(loop)}`;
			const orders: Order[] = [];
			for (let i = 0; i < K; i++) {
				const cartId = await h.cartWith([
					{ sku: "DIG-RACE", productId: "d-race", qty: 1, kind: "digital" },
				]);
				const created = await createOrderFromCart(h.createDeps, {
					cartId,
					idempotencyKey: idempotencyKey(`rr-${String(loop)}-${String(i)}`),
					buyerRef: `b${String(i)}@example.com`,
					paymentMethod: "stripe",
				});
				if (!created.ok) throw new Error(`${tag}: checkout failed: ${created.reason}`);
				orders.push(created.order);
			}

			// ONE receipt: the same dedupe key and provider ref, each copy naming a
			// different order — the caller's claim is the only thing that differs.
			const receipt = `evt-shared-${String(loop)}`;
			const providerRef = `pi-shared-${String(loop)}`;
			const results: SettleOutcome[] = await Promise.all(
				orders.map((order) =>
					settleCaptured(
						settleOrder(
							settleDeps,
							h.stripeGateway,
							h.stripeGateway.webhook({
								outcome: "succeeded",
								orderId: order.id,
								providerRef,
								amount: order.totals.total,
								currency: "USD",
								dedupeKey: receipt,
							}),
						),
					),
				),
			);

			expect(
				results.flatMap((r) => (r.kind === "threw" ? [String(r.err)] : [])),
				`${tag}: thrown`,
			).toEqual([]);
			const settled = results.map((r) => (r.kind === "settled" ? r.result : undefined));
			const winners = orders.filter((_o, i) => settled[i]?.ok === true);
			expect(winners, `${tag}: orders that bound the receipt`).toHaveLength(1);
			const winner = winners[0]!;
			const losers = orders.filter((o) => o.id !== winner.id);
			for (const [i, order] of orders.entries()) {
				if (order.id === winner.id) continue;
				expect(settled[i], `${tag}: ${order.id}`).toEqual({
					ok: false,
					reason: "RECEIPT_REBOUND",
				});
			}

			// The stored truth agrees: one paid order, the rest untouched — and ONE
			// receipt is ONE ledger row, on the winner, under the shared provider ref.
			for (const order of orders) {
				const doc = await h.orders.get(order.id);
				if (doc === null) throw new Error(`${tag}: missing order document ${order.id}`);
				const stored = normalizeOrderDoc(doc);
				const isWinner = order.id === winner.id;
				expect(stored.state, `${tag}: ${order.id}`).toBe(isWinner ? "paid" : "pending");
				expect(
					stored.payments.filter((p) => p.providerRef === providerRef),
					`${tag}: ${order.id} ledger`,
				).toHaveLength(isWinner ? 1 : 0);
			}
			expect((await paymentRefs.get(providerRef))?.orderId, `${tag}: payment ref`).toBe(winner.id);
			// The receipt is bound to the winner, and only to the winner.
			expect(await settleDeps.paymentEventStore.orderForDedupeKey(receipt), `${tag}: bound`).toBe(
				winner.id,
			);

			// Every loser's ATTEMPT is recorded, against the order it was aimed at,
			// naming the order that legitimately owns the receipt.
			const loserIds = new Set<string>(losers.map((o) => o.id));
			const rebound = (await listAnomalies()).filter(
				(a) => a.kind === "RECEIPT_REBOUND" && loserIds.has(a.orderId),
			);
			expect(new Set(rebound.map((a) => a.orderId)), `${tag}: anomalies`).toEqual(loserIds);
			for (const a of rebound) expect(a.detail, `${tag}: detail`).toContain(winner.id);
			// …and none against the winner.
			expect(
				(await listAnomalies()).filter((a) => a.orderId === winner.id),
				`${tag}: winner anomalies`,
			).toHaveLength(0);
		}
	}, 180_000);

	test(`${String(K)} concurrent deliveries of ONE event to its OWN order all re-drive; a foreign event's leave no row (#616)`, async () => {
		// `settleOrder` reads the order BEFORE it claims the dedupe key (#616), so
		// every racer of a same-order duplicate holds an order snapshot taken before
		// the claim. Exactly one claims; every other one reads the binding back as
		// its own order and re-drives — never a false RECEIPT_REBOUND. A foreign
		// event (no such order) claims nothing at all, however many copies race.
		const h: OrderHarness = makeOrderHarness(storage);
		const paymentEventStore = new EmdashPaymentEventStore({ storage });
		const settleDeps = { ...h.settleDeps, paymentEventStore };
		const events = collectionOf<PaymentEventDoc>(storage, PAYMENT_EVENTS_COLLECTION);
		const anomalies = collectionOf<PaymentAnomalyDoc>(storage, PAYMENT_ANOMALIES_COLLECTION);
		await h.seedDigital({ productId: "d-dup", sku: "DIG-DUP", priceCents: 900, title: "Ebook" });
		const raced = new Set<string>();

		for (let loop = 0; loop < LOOPS; loop++) {
			const tag = `loop ${String(loop)}`;
			const cartId = await h.cartWith([
				{ sku: "DIG-DUP", productId: "d-dup", qty: 1, kind: "digital" },
			]);
			const created = await createOrderFromCart(h.createDeps, {
				cartId,
				idempotencyKey: idempotencyKey(`dup-${String(loop)}`),
				buyerRef: "dup@example.com",
				paymentMethod: "stripe",
			});
			if (!created.ok) throw new Error(`${tag}: checkout failed: ${created.reason}`);
			const order = created.order;
			raced.add(order.id);
			raced.add(`wc_${String(loop)}`);
			const own = h.stripeGateway.webhook({
				outcome: "succeeded",
				orderId: order.id,
				providerRef: `pi-dup-${String(loop)}`,
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: `evt-dup-${String(loop)}`,
			});
			const foreignKey = `evt-foreign-${String(loop)}`;
			const foreign = h.stripeGateway.webhook({
				outcome: "succeeded",
				orderId: `wc_${String(loop)}`,
				providerRef: `pi-foreign-${String(loop)}`,
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: foreignKey,
			});

			const results: SettleOutcome[] = await Promise.all([
				...Array.from({ length: K }, () =>
					settleCaptured(settleOrder(settleDeps, h.stripeGateway, own)),
				),
				...Array.from({ length: K }, () =>
					settleCaptured(settleOrder(settleDeps, h.stripeGateway, foreign)),
				),
			]);
			expect(
				results.flatMap((r) => (r.kind === "threw" ? [String(r.err)] : [])),
				`${tag}: thrown`,
			).toEqual([]);
			const settled = results.map((r) => (r.kind === "settled" ? r.result : undefined));
			for (const r of settled.slice(0, K)) expect(r?.ok, `${tag}: own delivery`).toBe(true);
			for (const r of settled.slice(K)) {
				expect(r, `${tag}: foreign delivery`).toEqual({
					ok: false,
					reason: "ORDER_NOT_FOUND",
					orderId: `wc_${String(loop)}`,
					dedupeKey: foreignKey,
				});
			}

			const doc = await h.orders.get(order.id);
			if (doc === null) throw new Error(`${tag}: missing order document ${order.id}`);
			const stored = normalizeOrderDoc(doc);
			expect(stored.state, `${tag}: state`).toBe("paid");
			expect(stored.payments, `${tag}: ledger`).toHaveLength(1);
			expect(
				await paymentEventStore.orderForDedupeKey(`evt-dup-${String(loop)}`),
				`${tag}: bound`,
			).toBe(order.id);
			expect(await events.get(foreignKey), `${tag}: foreign row`).toBeNull();
		}
		// No anomaly of any kind against a raced order: not a false RECEIPT_REBOUND on
		// the own-order duplicates, and nothing at all for the foreign ones.
		const found: PaymentAnomalyDoc[] = [];
		let cursor: string | undefined;
		do {
			const page = await anomalies.query({ limit: 100, cursor });
			for (const { data } of page.items) found.push(data);
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);
		expect(found.filter((a) => raced.has(a.orderId))).toEqual([]);
	}, 180_000);
});
