/**
 * The order store's rollup hook: what it emits, when, and what it must never do to
 * the transition it follows.
 *
 * The hook is the only edit the reporting adapter makes to another store, and it is
 * additive by construction — one call after the order write is DURABLE, with the
 * payload a bucket needs (which order, in what currency, created when, leaving
 * which state for which, carrying what total; and for a refund, which refund and
 * how much). Three properties are load-bearing and each has a case here:
 *
 *  - **Exactly once per won write.** The flip runs inside a compare-and-set retry
 *    loop, so a hook inside the loop body would fire once per attempt; a LOST flip
 *    (the second caller of `markPaid`) wrote nothing and owes no event at all.
 *  - **After durability.** The event describes a state that is already committed,
 *    so a rollup built from it can never claim a transition the orders disagree with.
 *  - **Never fatal.** Reporting is derived data. A writer that throws must leave the
 *    transition committed, the order readable, and the caller's answer unchanged —
 *    the recompute is what makes the counters exact again.
 */
import { cents, createOrderFromCart, currency, idempotencyKey, orderId } from "@otta-sh/domain";
import type { SeedOrderSummaryRow } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import type { ReportingOrderEvent, ReportingRollupWriter } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";

/** A writer that records what it was handed. */
function recorder(): { writer: ReportingRollupWriter; events: ReportingOrderEvent[] } {
	const events: ReportingOrderEvent[] = [];
	return {
		events,
		writer: {
			async recordOrderEvent(event) {
				events.push(event);
			},
		},
	};
}

/** A writer that always dies. Reporting is derived; the transition is not. */
const throwing: ReportingRollupWriter = {
	async recordOrderEvent() {
		throw new Error("the rollup writer is down");
	},
};

const SEEDED_AT = "2026-07-10T00:00:00.000Z";

/** One bare seeded order, at a known instant, state and total. */
async function seeded(
	h: OrderHarness,
	id: string,
	state: SeedOrderSummaryRow["state"],
	total: number,
): Promise<void> {
	await h.seedOrder({
		id,
		state,
		currency: "USD",
		createdAt: SEEDED_AT,
		buyerRef: `${id}@example.test`,
		totalCents: total,
	});
}

/**
 * A captured payment, because the refund CEILING is what was captured (arbitrated
 * against the frozen total), not what the order says it owes — a seeded order with no
 * payments can be refunded by nothing at all.
 */
async function captured(h: OrderHarness, id: string, amount: number): Promise<void> {
	await h.store.recordPayment({
		orderId: orderId(id),
		gateway: "stripe",
		providerRef: `pi-${id}`,
		amount: cents(amount),
		currency: currency("USD"),
		status: "succeeded",
	});
}

describeEachDialect("EmdashOrderStore reporting hook", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);

	test("a won transition emits exactly one event, carrying the order's creation day and its net total", async () => {
		const { writer, events } = recorder();
		const h = makeOrderHarness(bound.storage, { reporting: writer });
		await seeded(h, "h1", "pending", 4321);
		expect(await h.store.markPaid(orderId("h1"))).toBe(true);
		expect(events).toEqual([
			{
				kind: "transition",
				orderId: "h1",
				orderCreatedAt: SEEDED_AT,
				currency: "USD",
				fromState: "pending",
				toState: "paid",
				orderTotalCents: 4321,
			},
		]);
	});

	test("a LOST transition emits nothing — the second caller wrote no state", async () => {
		const { writer, events } = recorder();
		const h = makeOrderHarness(bound.storage, { reporting: writer });
		await seeded(h, "h2", "pending", 100);
		expect(await h.store.markPaid(orderId("h2"))).toBe(true);
		expect(await h.store.markPaid(orderId("h2"))).toBe(false);
		expect(events).toHaveLength(1);
	});

	test("creating an order emits the arrival into `pending`, once, with no previous state", async () => {
		const { writer, events } = recorder();
		const h = makeOrderHarness(bound.storage, { reporting: writer });
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("k-hook"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);
		expect(events).toEqual([
			{
				kind: "transition",
				orderId: res.order.id,
				orderCreatedAt: res.order.createdAt,
				currency: "USD",
				fromState: null,
				toState: "pending",
				orderTotalCents: res.order.totals.total,
			},
		]);
		// A replay of the same idempotency key creates nothing, so it owes no event.
		const replay = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("k-hook"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		expect(replay.ok).toBe(true);
		expect(events).toHaveLength(1);
	});

	test("a finalized refund emits a refund event; a partial one flips nothing", async () => {
		const { writer, events } = recorder();
		const h = makeOrderHarness(bound.storage, { reporting: writer });
		await seeded(h, "h3", "paid", 1000);
		await captured(h, "h3", 1000);
		const recorded = await h.store.recordRefund({
			orderId: orderId("h3"),
			amount: cents(250),
			currency: currency("USD"),
			kind: "manual",
			gateway: "stripe",
			refundRef: null,
			reason: "partial return",
			refundedBy: "admin@shop",
			idempotencyKey: idempotencyKey("rf-h3"),
		});
		expect(recorded.outcome).toBe("recorded");
		expect(events).toEqual([
			{
				kind: "refund",
				orderId: "h3",
				orderCreatedAt: SEEDED_AT,
				currency: "USD",
				refundId: recorded.refund?.id,
				refundedCents: 250,
			},
		]);
	});

	test("a refund that reaches the ceiling emits the refund AND the flip to `refunded`", async () => {
		const { writer, events } = recorder();
		const h = makeOrderHarness(bound.storage, { reporting: writer });
		await seeded(h, "h4", "paid", 900);
		await captured(h, "h4", 900);
		const recorded = await h.store.recordRefund({
			orderId: orderId("h4"),
			amount: cents(900),
			currency: currency("USD"),
			kind: "manual",
			gateway: "stripe",
			refundRef: null,
			reason: "full return",
			refundedBy: "admin@shop",
			idempotencyKey: idempotencyKey("rf-h4"),
		});
		expect(recorded.fullyRefunded).toBe(true);
		expect(events).toEqual([
			{
				kind: "refund",
				orderId: "h4",
				orderCreatedAt: SEEDED_AT,
				currency: "USD",
				refundId: recorded.refund?.id,
				refundedCents: 900,
			},
			{
				kind: "transition",
				orderId: "h4",
				orderCreatedAt: SEEDED_AT,
				currency: "USD",
				fromState: "paid",
				toState: "refunded",
				orderTotalCents: 900,
			},
		]);
		// A replay of the same refund key writes nothing, so it owes no event.
		await h.store.recordRefund({
			orderId: orderId("h4"),
			amount: cents(900),
			currency: currency("USD"),
			kind: "manual",
			gateway: "stripe",
			refundRef: null,
			reason: "full return",
			refundedBy: "admin@shop",
			idempotencyKey: idempotencyKey("rf-h4"),
		});
		expect(events).toHaveLength(2);
	});

	test("a writer that throws leaves the transition committed and the order readable", async () => {
		const h = makeOrderHarness(bound.storage, { reporting: throwing });
		await seeded(h, "h5", "pending", 777);
		// The store's answer is unchanged: the flip won.
		expect(await h.store.markPaid(orderId("h5"))).toBe(true);
		expect((await h.orders.get("h5"))?.state).toBe("paid");
		expect((await h.store.getById(orderId("h5")))?.state).toBe("paid");
		// And a second flip still refuses, so no state was left half-written.
		expect(await h.store.markPaid(orderId("h5"))).toBe(false);
	});

	test("a writer that throws does not fail a refund either", async () => {
		const h = makeOrderHarness(bound.storage, { reporting: throwing });
		await seeded(h, "h6", "paid", 500);
		await captured(h, "h6", 500);
		const recorded = await h.store.recordRefund({
			orderId: orderId("h6"),
			amount: cents(500),
			currency: currency("USD"),
			kind: "manual",
			gateway: "stripe",
			refundRef: null,
			reason: null,
			refundedBy: "admin@shop",
			idempotencyKey: idempotencyKey("rf-h6"),
		});
		expect(recorded.outcome).toBe("recorded");
		expect(recorded.fullyRefunded).toBe(true);
		expect((await h.orders.get("h6"))?.state).toBe("refunded");
	});
});
