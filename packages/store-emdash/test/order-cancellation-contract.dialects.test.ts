/**
 * The domain's `orderCancellationContract` against `EmdashOrderStore`, on both Node
 * dialects, in full — plus the two Postgres-only concurrency cases the SQL suite of
 * the same name carries, ported unchanged, and the hold-release case this store owes
 * that the SQL adapter did not.
 *
 * The cancellation reason rides the guarded flip exactly as the fulfillment envelope
 * does, so "cancelled with no reason recorded" is unreachable through this path and a
 * replay — which is a 0-row flip — can never overwrite the first caller's reason. The
 * cancel ALSO records the release intent this store's expiry flip records, because a
 * cancelled order no longer claims its holds; `releaseAdopted` is order-scoped,
 * ADOPTED-only, and an unconditional no-op on any miss, which is what makes the
 * paid-then-cancelled case below safe.
 */
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
import { expect, test } from "vitest";
import { cancellationReleaseCase } from "./order-cancellation-release.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, orderTransitionHarness } from "./order-harness.js";

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

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}

/** Seed an order straight to `processing` — cancellable, and the state
 *  `recordFulfillment` also accepts, so the two use-cases can race on it —
 *  draining + resetting the pre-cancel emails so a later assertion counts only the
 *  cancelled one. */
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

describeEachDialect("EmdashOrderStore cancellation", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	const harness = async (): Promise<OrderTransitionHarness> =>
		orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true }));

	orderCancellationContract(harness, { dialect: ctx.dialect });

	// The release bracket's sharp edge, on every dialect INCLUDING D1 — hence a shared
	// module rather than a case inlined here (see `order-cancellation-release.ts`).
	cancellationReleaseCase(() => makeOrderHarness(bound.storage));

	// Concurrency (Postgres-required, like the no-oversell race): N concurrent
	// cancelOrder calls on the SAME cancellable order must cancel it EXACTLY ONCE —
	// the guarded `state === fromState` flip makes one caller win and record its
	// reason; the rest observe the already-cancelled order. Exactly one cancelled
	// email is enqueued (the first-wins `(orderId, toState)` outbox entry).
	test.runIf(ctx.canRace)(
		"concurrent cancelOrder cancels exactly once (no double reason / no double email)",
		async () => {
			const h = await harness();
			const id = await seedProcessing(h, "ord-cancel-race", "key-cancel-race");
			const N = 8;
			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					cancelOrder(
						{ orderStore: h.store },
						{
							orderId: id,
							reason: "customer_request",
							cancelledBy: `concurrent-${String(i)}`,
							idempotencyKey: idempotencyKey(`c:${id}:${String(i)}`),
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
		},
		120_000,
	);

	// cancelOrder-vs-recordFulfillment: the reasoned-cancel counterpart of the
	// fulfillment suite's record-vs-bare-transition race. The state flip is the
	// arbiter — exactly one wins. If cancel wins, the order is cancelled-with-a-reason
	// and fulfillment is a NOT_FULFILLABLE no-op (never shipped behind the cancel's
	// back); if fulfillment wins, cancel's guarded flip is a 0-row no-op
	// (NOT_CANCELLABLE) — the order is never both.
	test.runIf(ctx.canRace)(
		"cancelOrder racing recordFulfillment: exactly one wins, the order is never both",
		async () => {
			const h = await harness();
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
		},
		120_000,
	);
});
