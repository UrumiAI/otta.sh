import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import {
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type OrderId,
} from "../money/ids.js";
import type { CreateOrderInput } from "../ports/order-store.js";
import { cancelOrder } from "../orders/cancel-order.js";
import { dispatchOrderEmails, transitionOrder } from "../orders/transition.js";
import type { OrderTransitionHarness } from "./order-transition-contract.js";

const USD = currency("USD");

function pendingInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-c1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-c1"),
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
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

async function seedPending(
	h: OrderTransitionHarness,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const { order } = await h.store.createFromCart(pendingInput(overrides));
	return order.id;
}

function drive(
	h: OrderTransitionHarness,
	id: OrderId,
	to: "paid" | "processing" | "shipped" | "cancelled",
) {
	return transitionOrder(
		{ orderStore: h.store },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
	);
}

/** Seed an order and drive it to `paid` (still cancellable), draining the
 *  pre-cancel emails so a later assertion counts only the cancelled one. */
async function seedPaid(
	h: OrderTransitionHarness,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const id = await seedPending(h, overrides);
	await drive(h, id, "paid");
	await dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
	h.emailSender.reset();
	return id;
}

function cancel(
	h: OrderTransitionHarness,
	id: OrderId,
	over: Partial<{
		reason: "customer_request" | "fraud_suspected" | "out_of_stock" | "pricing_error" | "other";
		detail: string | null;
		cancelledBy: string;
		key: string;
	}> = {},
) {
	return cancelOrder(
		{ orderStore: h.store },
		{
			orderId: id,
			reason: over.reason ?? "customer_request",
			...(over.detail !== undefined ? { detail: over.detail } : {}),
			cancelledBy: over.cancelledBy ?? "admin@shop",
			idempotencyKey: idempotencyKey(over.key ?? `c:${id}`),
		},
	);
}

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}

/**
 * The reusable order-cancellation spec (admin-UX Increment 1, "cancel with
 * reason"). Encodes: cancelling with a reason drives `{pending,paid,processing}
 * → cancelled` and records the reason envelope atomically; the cancelled
 * notification carries it; the compose is idempotent under replay;
 * cancellation is legal ONLY from a state the state machine allows to cancel
 * (derived, never hardcoded); a bare-transition cancellation (no reason) is
 * NOT back-fillable via this compose; and the mutable-envelope-only invariant
 * (line items untouched). Runs against the fake first, then each SQL dialect.
 */
export function orderCancellationContract(
	makeHarness: () => Promise<OrderTransitionHarness>,
	opts: { dialect: string },
): void {
	describe(`orderCancellationContract [${opts.dialect}]`, () => {
		test("cancelling a pending order records the reason and moves it to cancelled", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			const res = await cancel(h, id, {
				reason: "out_of_stock",
				detail: "last unit sold on another channel",
				cancelledBy: "ops-desk",
			});
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.cancelled).toBe(true);
			const order = await h.store.getById(id);
			expect(order?.state).toBe("cancelled");
			expect(order?.cancellation).toMatchObject({
				reason: "out_of_stock",
				detail: "last unit sold on another channel",
				cancelledBy: "ops-desk",
			});
			expect(order?.cancellation?.cancelledAt).toBeTruthy();
			// Line items are untouched — cancellation is mutable-envelope only.
			expect(order?.lines.map((l) => l.title)).toEqual(["Widget"]);
		});

		test("cancelling a paid order (pre-fulfillment) is legal", async () => {
			const h = await makeHarness();
			const id = await seedPaid(h);
			const res = await cancel(h, id, { reason: "customer_request" });
			expect(res.ok).toBe(true);
			expect((await h.store.getById(id))?.state).toBe("cancelled");
		});

		test("cancelling a processing order (pre-shipment) is legal", async () => {
			const h = await makeHarness();
			const id = await seedPaid(h);
			await drive(h, id, "processing");
			await dispatch(h);
			h.emailSender.reset();
			const res = await cancel(h, id, { reason: "pricing_error" });
			expect(res.ok).toBe(true);
			expect((await h.store.getById(id))?.state).toBe("cancelled");
		});

		test("the cancelled notification carries the reason (not a reason-free notice)", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			await cancel(h, id, { reason: "fraud_suspected", detail: "chargeback risk flagged" });
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-cancelled", id)).toBe(1);
			const sent = h.emailSender.sends.find((s) => s.template === "order-cancelled");
			expect(sent?.data["cancellation"]).toMatchObject({
				reason: "fraud_suspected",
				detail: "chargeback risk flagged",
			});
		});

		test("an absent/blank detail normalizes to null", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			const res = await cancel(h, id, { detail: "   " });
			expect(res.ok).toBe(true);
			expect((await h.store.getById(id))?.cancellation?.detail).toBeNull();
		});

		test("replaying cancelOrder is an idempotent no-op and sends exactly one cancelled email", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			const first = await cancel(h, id, { reason: "customer_request" });
			const replay = await cancel(h, id, { reason: "other", detail: "should not overwrite" });
			expect(first.ok).toBe(true);
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.cancelled).toBe(false); // already cancelled ⇒ no-op
			// The FIRST reason stands — a racing/replayed loser never overwrites it.
			const order = await h.store.getById(id);
			expect(order?.cancellation?.reason).toBe("customer_request");
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-cancelled", id)).toBe(1);
		});

		test("cancelling a terminal (shipped) order is rejected NOT_CANCELLABLE", async () => {
			const h = await makeHarness();
			const id = await seedPaid(h);
			await drive(h, id, "processing");
			await drive(h, id, "shipped");
			await dispatch(h);
			h.emailSender.reset();
			const res = await cancel(h, id);
			expect(res).toEqual({ ok: false, reason: "NOT_CANCELLABLE" });
			expect((await h.store.getById(id))?.state).toBe("shipped");
		});

		test("cancelling an order already cancelled WITHOUT a reason (bare transition) is rejected, never back-filled", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			// The bare transition — no reason envelope.
			await drive(h, id, "cancelled");
			const res = await cancel(h, id);
			expect(res).toEqual({ ok: false, reason: "NOT_CANCELLABLE" });
			expect((await h.store.getById(id))?.cancellation).toBeNull();
		});

		test("cancelling a missing order is ORDER_NOT_FOUND", async () => {
			const h = await makeHarness();
			const res = await cancel(h, orderId("ord-nope"));
			expect(res).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
		});

		test("a blank cancelledBy is rejected before any write", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			expect(await cancel(h, id, { cancelledBy: "   " })).toEqual({
				ok: false,
				reason: "EMPTY_CANCELLED_BY",
			});
			expect((await h.store.getById(id))?.state).toBe("pending");
		});
	});
}
