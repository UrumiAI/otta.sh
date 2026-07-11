import {
	cents,
	currency,
	email,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	requestLogin,
	sku,
	verifyLogin,
	type CreateOrderInput,
	type VerifyLoginDeps,
} from "@urumi/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryCredentialVerifier,
	InMemoryCustomerStore,
	InMemoryOrderStore,
	InMemorySessionStore,
} from "@urumi/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";

// Step 5.2 (use-case layer): the requestLogin/verifyLogin orchestration over the
// four customer/auth fakes — magic-link round trip, first-login account
// creation, guest-order linking, and session minting.

const USD = currency("USD");

let clock: FixedClock;
let customerStore: InMemoryCustomerStore;
let sessionStore: InMemorySessionStore;
let orderStore: InMemoryOrderStore;
let verifier: InMemoryCredentialVerifier;
let deps: VerifyLoginDeps;

beforeEach(() => {
	clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	customerStore = new InMemoryCustomerStore({ idGen: new CountingIdGen("cust"), clock });
	sessionStore = new InMemorySessionStore({ idGen: new CountingIdGen("sess"), clock });
	orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	verifier = new InMemoryCredentialVerifier({
		customerStore,
		idGen: new CountingIdGen("chal"),
		clock,
	});
	deps = { credentialVerifier: verifier, customerStore, sessionStore, orderStore, clock };
});

function guestOrder(buyerRef: string, id: string): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey(`k-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef,
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

describe("magic-link login use-cases (5.2)", () => {
	test("a first-ever login creates the customer, verifies the email, and mints a session", async () => {
		const { challengeId, token } = await requestLogin(
			{ credentialVerifier: verifier },
			{ email: email("new@example.com") },
		);
		const result = await verifyLogin(deps, { challengeId, token });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(await sessionStore.validate(result.sessionToken)).toBe(result.customerId);
			const customer = await customerStore.getByEmail(email("new@example.com"));
			expect(customer?.id).toBe(result.customerId);
			expect(customer?.emailVerifiedAt).not.toBeNull();
		}
	});

	test("login links a pre-existing guest order with the same email (§9 Risk 3)", async () => {
		await orderStore.createFromCart(guestOrder("guest@example.com", "ord-guest"));
		const { challengeId, token } = await requestLogin(
			{ credentialVerifier: verifier },
			{ email: email("guest@example.com") },
		);
		const result = await verifyLogin(deps, { challengeId, token });
		expect(result.ok).toBe(true);
		if (result.ok) {
			const owned = await orderStore.listForCustomer(result.customerId);
			expect(owned.map((o) => o.id)).toEqual([orderId("ord-guest")]);
		}
	});

	test("a stale (consumed) challenge is rejected, mints no session", async () => {
		const { challengeId, token } = await requestLogin(
			{ credentialVerifier: verifier },
			{ email: email("once@example.com") },
		);
		await verifyLogin(deps, { challengeId, token }); // consume
		const replay = await verifyLogin(deps, { challengeId, token });
		expect(replay).toEqual({ ok: false, reason: "CONSUMED" });
	});
});
