import {
	cents,
	currency,
	dispatchOrderEmails,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	transitionOrder,
	type CreateOrderInput,
	type OrderState,
} from "@urumi/domain";
import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
} from "@urumi/domain/testing";
import { describe, expect, test } from "vitest";

// Step 5.3: EmailSender port + FakeEmailSender + outbox-backed transition, all
// against fakes — the exactly-once assertions (headline cases 4–6).

const USD = currency("USD");

function harness() {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	const emailSender = new FakeEmailSender();
	return { store, clock, emailSender };
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

async function drive(store: InMemoryOrderStore, id: string, to: OrderState) {
	return transitionOrder(
		{ orderStore: store },
		{
			orderId: orderId(id),
			toState: to,
			idempotencyKey: idempotencyKey(`t:${id}:${to}`),
		},
	);
}

describe("outbox-backed transition emails (5.3)", () => {
	test("paid to processing enqueues exactly one order-processing email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "paid");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock }); // drain confirmation
		await drive(store, "ord-1", "processing");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.countByTemplate("order-processing", "ord-1")).toBe(1);
	});

	test("the same transition applied twice sends exactly one email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "paid");
		await drive(store, "ord-1", "paid"); // redelivery / double admin call
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		await dispatchOrderEmails({ orderStore: store, emailSender, clock }); // second tick, nothing new
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
		expect(store.outboxFor("ord-1")).toHaveLength(1);
	});

	test("an invalid transition enqueues zero emails", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		const res = await drive(store, "ord-1", "delivered"); // illegal from pending
		expect(res.ok).toBe(false);
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.sends).toHaveLength(0);
		expect(store.outboxFor("ord-1")).toHaveLength(0);
	});

	test("pending to expired enqueues exactly one order-expired email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "expired");
		expect(await dispatchOrderEmails({ orderStore: store, emailSender, clock })).toBe(1);
		expect(emailSender.countByTemplate("order-expired", "ord-1")).toBe(1);
	});

	test("markPaid (the Phase-4 flip) also enqueues a confirmation email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		expect(await store.markPaid(orderId("ord-1"))).toBe(true);
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
	});

	test("markFailed (the Phase-4 flip) enqueues no email — pending→failed has no template", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		expect(await store.markFailed(orderId("ord-1"))).toBe(true);
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.sends).toHaveLength(0);
	});
});
