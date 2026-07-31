import {
	dispatchOrderEmails,
	idempotencyKey,
	orderId,
	productId,
	recordFulfillment,
	reservationId,
	sku,
	transitionOrder,
	cents,
	currency,
	type CreateOrderInput,
	type OrderId,
} from "@otta-sh/domain";
import { orderFulfillmentContract, type OrderTransitionHarness } from "@otta-sh/domain/testing";
import { afterEach, describe, expect, test } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderTransitionHarness,
	makeSqliteOrderTransitionHarness,
	teardownOrderFlow,
} from "./order-harness.js";

// The order-fulfillment spec on the real adapters (admin-UX Increment 1). SQLite
// verifies the DDL + the record/ship/enqueue compose; Postgres additionally runs
// the concurrency races below (SQLite serializes writes, so it can't race).

afterEach(teardownOrderFlow);

orderFulfillmentContract(makeSqliteOrderTransitionHarness, { dialect: "sqlite" });

const USD = currency("USD");

function pendingInput(id: string, key: string): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey(key),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
	};
}

/** Seed an order straight to `processing` (fulfillment's only legal from-state),
 *  draining + resetting the pre-ship emails so a later assertion counts only the
 *  shipped one. */
async function seedProcessing(
	h: OrderTransitionHarness,
	id: string,
	key: string,
): Promise<OrderId> {
	const { order } = await h.store.createFromCart(pendingInput(id, key));
	for (const to of ["paid", "processing"] as const) {
		await transitionOrder(
			{ orderStore: h.store },
			{ orderId: order.id, toState: to, idempotencyKey: idempotencyKey(`t:${order.id}:${to}`) },
		);
	}
	await dispatch(h);
	h.emailSender.reset();
	return order.id;
}

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderFulfillmentContract(makePgOrderTransitionHarness, { dialect: "pg" });

	// Concurrency (Postgres-required, like the no-oversell race): N concurrent
	// record-fulfillment calls on the SAME processing order must ship it EXACTLY
	// ONCE — the guarded `WHERE state='processing'` flip makes one caller win and
	// records its tracking; the rest observe the already-shipped order. Exactly one
	// shipped email is enqueued (outbox `UNIQUE(order_id, to_state)`).
	test("concurrent record-fulfillment ships exactly once (no double fulfillment / no double email)", async () => {
		const h = await makePgOrderTransitionHarness();
		const id = await seedProcessing(h, "ord-race", "key-race");
		const N = 8;
		const results = await Promise.all(
			Array.from({ length: N }, (_v, i) =>
				recordFulfillment(
					{ orderStore: h.store },
					{
						orderId: id,
						carrier: "UPS",
						trackingNumber: `1Z-${i}`,
						recordedBy: "concurrent",
						idempotencyKey: idempotencyKey(`f:${id}:${i}`),
					},
				),
			),
		);
		// Exactly one caller won the guarded flip and recorded; the rest are benign
		// no-ops (recorded:false) — none is an error.
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.filter((r) => r.ok && r.recorded)).toHaveLength(1);
		const order = await h.store.getById(id);
		expect(order?.state).toBe("shipped");
		expect(order?.fulfillment).not.toBeNull();
		// Exactly one shipped email drains.
		expect(await dispatch(h)).toBe(1);
		expect(h.emailSender.countByTemplate("order-shipped", id)).toBe(1);
		// The state-change audit rode the SAME guarded flip transaction — exactly
		// ONE `processing → shipped` event, never one per losing caller (timeline
		// slice: a replay/lost race is a 0-row flip and records no event).
		const shippedEvents = (await h.store.listEventsForOrder(id)).filter(
			(e) => e.toState === "shipped",
		);
		expect(shippedEvents).toHaveLength(1);
		expect(shippedEvents[0]).toMatchObject({ fromState: "processing", actor: "concurrent" });
	});

	// Record-vs-cancel: a record-fulfillment and a `processing → cancelled`
	// transition race on the same order. The state flip is the arbiter — exactly one
	// wins. If cancel wins, the order is cancelled and record is a NOT_FULFILLABLE
	// no-op (never shipped behind the cancel's back); if record wins, cancel's
	// guarded `WHERE state='processing'` flip is a 0-row no-op.
	test("record-fulfillment racing a cancel: exactly one wins, the order is never both", async () => {
		const h = await makePgOrderTransitionHarness();
		const id = await seedProcessing(h, "ord-vs-cancel", "key-vs-cancel");
		const [fulfil, cancel] = await Promise.all([
			recordFulfillment(
				{ orderStore: h.store },
				{
					orderId: id,
					carrier: "UPS",
					trackingNumber: "1Z-vs",
					recordedBy: "shipper",
					idempotencyKey: idempotencyKey(`f:${id}`),
				},
			),
			transitionOrder(
				{ orderStore: h.store },
				{ orderId: id, toState: "cancelled", idempotencyKey: idempotencyKey(`t:${id}:cancelled`) },
			),
		]);
		const finalState = (await h.store.getById(id))?.state;
		expect(["shipped", "cancelled"]).toContain(finalState);
		if (finalState === "shipped") {
			// Record won: it shipped + recorded; the cancel found no processing row.
			expect(fulfil.ok && fulfil.recorded).toBe(true);
			expect(cancel.ok && cancel.transitioned).toBe(false);
			expect((await h.store.getById(id))?.fulfillment).not.toBeNull();
		} else {
			// Cancel won: the order is cancelled with no fulfillment; record is a no-op.
			expect(cancel.ok && cancel.transitioned).toBe(true);
			expect(fulfil).toEqual({ ok: false, reason: "NOT_FULFILLABLE" });
			expect((await h.store.getById(id))?.fulfillment).toBeNull();
		}
	});
});

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}
