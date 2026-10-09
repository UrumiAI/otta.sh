import {
	cents,
	currency,
	customerId,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	transitionOrder,
	transitionOrderAsAdmin,
	type CreateOrderInput,
	type OrderState,
	type PaymentMethod,
} from "@otta-sh/domain";
import { CountingIdGen, FixedClock, InMemoryOrderStore } from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

// Step 5.1: OrderState machine + OrderStore.transition/listForCustomer against
// the in-memory fake (types + fake, no DB) — the named cases from the plan.

const USD = currency("USD");

function harness() {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	return { store, clock };
}

function pending(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
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
		...overrides,
	};
}

function key(id: string, to: OrderState) {
	return idempotencyKey(`t:${id}:${to}`);
}

describe("order state transition (5.1)", () => {
	test("transitions pending to paid", async () => {
		const { store } = harness();
		const { order } = await store.createFromCart(pending());
		const res = await transitionOrder(
			{ orderStore: store },
			{
				orderId: order.id,
				toState: "paid",
				idempotencyKey: key(order.id, "paid"),
			},
		);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.transitioned).toBe(true);
		expect((await store.getById(order.id))?.state).toBe("paid");
	});

	test("rejects pending to shipped as INVALID_TRANSITION", async () => {
		const { store } = harness();
		const { order } = await store.createFromCart(pending());
		const res = await transitionOrder(
			{ orderStore: store },
			{
				orderId: order.id,
				toState: "shipped",
				idempotencyKey: key(order.id, "shipped"),
			},
		);
		expect(res).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
		expect((await store.getById(order.id))?.state).toBe("pending");
	});

	test("accepts pending to expired as a legal Phase-4-authoritative transition", async () => {
		const { store } = harness();
		const { order } = await store.createFromCart(pending());
		const res = await transitionOrder(
			{ orderStore: store },
			{
				orderId: order.id,
				toState: "expired",
				idempotencyKey: key(order.id, "expired"),
			},
		);
		expect(res.ok).toBe(true);
		expect((await store.getById(order.id))?.state).toBe("expired");
	});

	test("replaying the same transition is a no-op and returns the current state", async () => {
		const { store } = harness();
		const { order } = await store.createFromCart(pending());
		await transitionOrder(
			{ orderStore: store },
			{
				orderId: order.id,
				toState: "paid",
				idempotencyKey: key(order.id, "paid"),
			},
		);
		const replay = await transitionOrder(
			{ orderStore: store },
			{
				orderId: order.id,
				toState: "paid",
				idempotencyKey: key(order.id, "paid"),
			},
		);
		expect(replay.ok).toBe(true);
		if (replay.ok) {
			expect(replay.transitioned).toBe(false);
			expect(replay.order.state).toBe("paid");
		}
	});

	test("unknown order id is ORDER_NOT_FOUND", async () => {
		const { store } = harness();
		const res = await transitionOrder(
			{ orderStore: store },
			{
				orderId: orderId("nope"),
				toState: "paid",
				idempotencyKey: key("nope", "paid"),
			},
		);
		expect(res).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
	});

	test("listForCustomer returns only that customer's orders", async () => {
		const { store } = harness();
		const a = await store.createFromCart(
			pending({
				orderId: orderId("ord-a"),
				idempotencyKey: idempotencyKey("k-a"),
				buyerRef: "a@x.com",
			}),
		);
		const b = await store.createFromCart(
			pending({
				orderId: orderId("ord-b"),
				idempotencyKey: idempotencyKey("k-b"),
				buyerRef: "b@x.com",
			}),
		);
		await store.linkGuestOrders(customerId("cust-a"), "a@x.com");
		await store.linkGuestOrders(customerId("cust-b"), "b@x.com");
		expect((await store.listForCustomer(customerId("cust-a"))).map((o) => o.id)).toEqual([
			a.order.id,
		]);
		expect((await store.listForCustomer(customerId("cust-b"))).map((o) => o.id)).toEqual([
			b.order.id,
		]);
	});
});

describe("a legacy order whose payment method no longer exists", () => {
	test("a hand-seeded paid x402 order can still be closed with Mark refunded", async () => {
		// An order placed before x402 was removed stores `paymentMethod: "x402"`.
		// Nothing can refund it through a provider, so Mark refunded — recording a
		// refund the operator made outside Otta — must stay open for it.
		const { store } = harness();
		const { order } = await store.createFromCart(
			pending({ paymentMethod: "x402" as unknown as PaymentMethod }),
		);
		const paid = await transitionOrder(
			{ orderStore: store },
			{ orderId: order.id, toState: "paid", idempotencyKey: key(order.id, "paid") },
		);
		expect(paid.ok).toBe(true);
		// Money captured and NOT returned through any provider — for a Stripe order
		// this is exactly what refuses Mark refunded (REFUND_THROUGH_MONEY).
		await store.recordPayment({
			orderId: order.id,
			gateway: "x402" as unknown as PaymentMethod,
			providerRef: "0xlegacy-tx",
			amount: cents(500),
			currency: USD,
			status: "succeeded",
		});

		const res = await transitionOrderAsAdmin(
			{ orderStore: store },
			{ orderId: order.id, toState: "refunded", idempotencyKey: key(order.id, "refunded") },
		);
		expect(res).toMatchObject({ ok: true });
		expect((await store.getById(order.id))?.state).toBe("refunded");
	});
});
