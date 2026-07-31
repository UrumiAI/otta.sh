import {
	cancelOrder,
	cents,
	currency,
	dispatchOrderEmails,
	idempotencyKey,
	orderId,
	productId,
	recordFulfillment,
	reservationId,
	sku,
	transitionOrder,
	type CreateOrderInput,
	type OrderId,
} from "@otta-sh/domain";
import { orderCancellationContract, type OrderTransitionHarness } from "@otta-sh/domain/testing";
import { afterEach, describe, expect, test } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderTransitionHarness,
	makeSqliteOrderTransitionHarness,
	teardownOrderFlow,
} from "./order-harness.js";

// The order-cancellation spec on the real adapters (admin-UX Increment 1,
// "cancel with reason"). SQLite verifies the DDL + the flip/record/enqueue
// compose; Postgres additionally runs the concurrency races below (SQLite
// serializes writes, so it can't race).

afterEach(teardownOrderFlow);

orderCancellationContract(makeSqliteOrderTransitionHarness, { dialect: "sqlite" });

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

/** Seed an order straight to `processing` — cancellable, and the state
 *  `recordFulfillment` also accepts, so the two use-cases can race on it —
 *  draining + resetting the pre-cancel emails so a later assertion counts only
 *  the cancelled one. */
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
	orderCancellationContract(makePgOrderTransitionHarness, { dialect: "pg" });

	// Concurrency (Postgres-required, like the no-oversell race): N concurrent
	// cancelOrder calls on the SAME cancellable order must cancel it EXACTLY
	// ONCE — the guarded `WHERE state=:fromState` flip makes one caller win and
	// record its reason; the rest observe the already-cancelled order. Exactly
	// one cancelled email is enqueued (outbox `UNIQUE(order_id, to_state)`).
	test("concurrent cancelOrder cancels exactly once (no double reason / no double email)", async () => {
		const h = await makePgOrderTransitionHarness();
		const id = await seedProcessing(h, "ord-cancel-race", "key-cancel-race");
		const N = 8;
		const results = await Promise.all(
			Array.from({ length: N }, (_v, i) =>
				cancelOrder(
					{ orderStore: h.store },
					{
						orderId: id,
						reason: "customer_request",
						cancelledBy: `concurrent-${i}`,
						idempotencyKey: idempotencyKey(`c:${id}:${i}`),
					},
				),
			),
		);
		// Exactly one caller won the guarded flip and recorded; the rest are benign
		// no-ops (cancelled:false) — none is an error.
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.filter((r) => r.ok && r.cancelled)).toHaveLength(1);
		const order = await h.store.getById(id);
		expect(order?.state).toBe("cancelled");
		expect(order?.cancellation).not.toBeNull();
		// Exactly one cancelled email drains.
		expect(await dispatch(h)).toBe(1);
		expect(h.emailSender.countByTemplate("order-cancelled", id)).toBe(1);
	});

	// cancelOrder-vs-recordFulfillment: extends #63's record-vs-cancel race (that
	// one raced recordFulfillment against the BARE transition) to the reasoned
	// cancel path. The state flip is the arbiter — exactly one wins. If cancel
	// wins, the order is cancelled-with-a-reason and fulfillment is a
	// NOT_FULFILLABLE no-op (never shipped behind the cancel's back); if
	// fulfillment wins, cancel's guarded `WHERE state='processing'` flip is a
	// 0-row no-op (NOT_CANCELLABLE) — the order is never both.
	test("cancelOrder racing recordFulfillment: exactly one wins, the order is never both", async () => {
		const h = await makePgOrderTransitionHarness();
		const id = await seedProcessing(h, "ord-cancel-vs-ship", "key-cancel-vs-ship");
		const [cancelled, fulfilled] = await Promise.all([
			cancelOrder(
				{ orderStore: h.store },
				{
					orderId: id,
					reason: "out_of_stock",
					cancelledBy: "ops",
					idempotencyKey: idempotencyKey(`c:${id}`),
				},
			),
			recordFulfillment(
				{ orderStore: h.store },
				{
					orderId: id,
					carrier: "UPS",
					trackingNumber: "1Z-vs-cancel",
					recordedBy: "shipper",
					idempotencyKey: idempotencyKey(`f:${id}`),
				},
			),
		]);
		const finalState = (await h.store.getById(id))?.state;
		expect(["cancelled", "shipped"]).toContain(finalState);
		if (finalState === "cancelled") {
			// Cancel won: it recorded the reason; fulfillment found no processing row.
			expect(cancelled.ok && cancelled.cancelled).toBe(true);
			expect(fulfilled).toEqual({ ok: false, reason: "NOT_FULFILLABLE" });
			expect((await h.store.getById(id))?.cancellation).not.toBeNull();
		} else {
			// Fulfillment won: the order shipped; cancel is a no-op.
			expect(fulfilled.ok && fulfilled.recorded).toBe(true);
			expect(cancelled).toEqual({ ok: false, reason: "NOT_CANCELLABLE" });
			expect((await h.store.getById(id))?.cancellation).toBeNull();
		}
	});
});

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}
