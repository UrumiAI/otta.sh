/**
 * The domain's `orderFulfillmentContract` against `EmdashOrderStore`, on both Node
 * dialects, in full — plus the two Postgres-only concurrency cases the SQL suite of
 * the same name carries, ported unchanged (better-sqlite3 serializes writes in one
 * process, so it verifies the shape and never the contention).
 *
 * Recording fulfillment IS shipping, and here that is one compare-and-set: the
 * guarded `processing → shipped` flip, the audit event, the first-wins `shipped`
 * outbox entry and the tracking envelope all ride the SAME write, so no reachable
 * state is "shipped with no fulfillment" or "fulfilled but not shipped" — the
 * property the SQL adapter got from a transaction, and the one
 * `order-crash-seams.dialects.test.ts` pins from the other side by parking that
 * write.
 *
 * The suite drains the outbox through `dispatchOrderEmails` to count the shipped
 * email, so it exercises the email-outbox lease this increment pulled forward; the
 * lease's own contract cases remain the lists increment's.
 */
import {
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
import { orderFulfillmentContract, type OrderTransitionHarness } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
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

describeEachDialect("EmdashOrderStore fulfillment", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	const harness = async (): Promise<OrderTransitionHarness> =>
		orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true }));

	orderFulfillmentContract(harness, { dialect: ctx.dialect });

	// Concurrency (Postgres-required, like the no-oversell race): N concurrent
	// record-fulfillment calls on the SAME processing order must ship it EXACTLY
	// ONCE — the guarded `state === 'processing'` flip makes one caller win and
	// records its tracking; the rest observe the already-shipped order. Exactly one
	// shipped email is enqueued (the first-wins `(orderId, toState)` outbox entry).
	test.runIf(ctx.canRace)(
		"concurrent record-fulfillment ships exactly once (no double fulfillment / no double email)",
		async () => {
			const h = await harness();
			const id = await seedProcessing(h, "ord-race", "key-race");
			const N = 8;
			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					recordFulfillment(
						{ orderStore: h.store },
						{
							orderId: id,
							carrier: "UPS",
							trackingNumber: `1Z-${String(i)}`,
							recordedBy: "concurrent",
							idempotencyKey: idempotencyKey(`f:${id}:${String(i)}`),
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
			// The state-change audit rode the SAME guarded write — exactly ONE
			// `processing → shipped` event, never one per losing caller (a replay or a
			// lost race is a 0-row flip and records no event).
			const shippedEvents = (await h.store.listEventsForOrder(id)).filter(
				(e) => e.toState === "shipped",
			);
			expect(shippedEvents).toHaveLength(1);
			expect(shippedEvents[0]).toMatchObject({ fromState: "processing", actor: "concurrent" });
		},
		120_000,
	);

	// Record-vs-cancel: a record-fulfillment and a `processing → cancelled`
	// transition race on the same order. The state flip is the arbiter — exactly one
	// wins. If cancel wins, the order is cancelled and record is a NOT_FULFILLABLE
	// no-op (never shipped behind the cancel's back); if record wins, cancel's
	// guarded flip is a 0-row no-op.
	test.runIf(ctx.canRace)(
		"record-fulfillment racing a cancel: exactly one wins, the order is never both",
		async () => {
			const h = await harness();
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
					{
						orderId: id,
						toState: "cancelled",
						idempotencyKey: idempotencyKey(`t:${id}:cancelled`),
					},
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
		},
		120_000,
	);
});
