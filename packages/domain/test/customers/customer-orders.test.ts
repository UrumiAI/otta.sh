import {
	cents,
	checkoutOwner,
	currency,
	email,
	idempotencyKey,
	listCustomerOrders,
	orderId,
	productId,
	reservationId,
	sku,
	type CreateOrderInput,
	type CustomerId,
} from "@otta-sh/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryCustomerStore,
	InMemoryOrderStore,
	InMemorySessionStore,
} from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";

// What a SESSION may claim for its customer. A session was minted by redeeming a
// magic link sent to the customer's email, so it proves that inbox exactly as the
// sign-in did — which is why both rules below are the sign-in's own
// (`linkGuestOrders`, case-insensitive on the buyer reference), applied at the
// moment the shopper is already signed in instead of at their next sign-in.

const USD = currency("USD");

let clock: FixedClock;
let customerStore: InMemoryCustomerStore;
let orderStore: InMemoryOrderStore;
let sessionStore: InMemorySessionStore;

beforeEach(() => {
	clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	customerStore = new InMemoryCustomerStore({ idGen: new CountingIdGen("cust"), clock });
	orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	sessionStore = new InMemorySessionStore({ idGen: new CountingIdGen("sess"), clock });
});

/** The real store for every call but `method`, which rejects with `err`. */
function failing<T extends object>(target: T, method: string, err: Error): T {
	return new Proxy(target, {
		get(t, prop) {
			if (prop === method) {
				return async () => {
					throw err;
				};
			}
			const value: unknown = Reflect.get(t, prop, t);
			return typeof value === "function" ? value.bind(t) : value;
		},
	});
}

async function signedIn(address: string): Promise<{ id: CustomerId; token: string }> {
	const id = await customer(address);
	return { id, token: (await sessionStore.create(id)).token };
}

async function customer(address: string): Promise<CustomerId> {
	return (await customerStore.create({ email: email(address) })).id;
}

function order(id: string, buyerRef: string, owner?: CustomerId): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: `cart-${id}`,
		currency: USD,
		idempotencyKey: idempotencyKey(`k-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef,
		...(owner !== undefined ? { customerId: owner } : {}),
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
				reservationId: reservationId(`res-${id}`),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
	};
}

describe("checkoutOwner — who a signed-in checkout's order belongs to", () => {
	const owner = (token: string, buyerRef: string, onError?: (err: unknown) => void) =>
		checkoutOwner(
			{ sessionStore, customerStore, ...(onError !== undefined ? { onError } : {}) },
			{ sessionToken: token, buyerRef },
		);

	test("the session's customer, when the order is placed under their own email", async () => {
		const ada = await signedIn("ada@example.com");
		expect(await owner(ada.token, "ada@example.com")).toBe(ada.id);
	});

	test("matched case-insensitively — the same fold the sign-in's guest linking uses", async () => {
		const ada = await signedIn("ada@example.com");
		expect(await owner(ada.token, "Ada@Example.COM")).toBe(ada.id);
	});

	// Ordering for someone else (a gift, a work address) must not file that address's
	// order under this account: the session proves THIS inbox, not that one. It stays a
	// guest order, claimable by whoever proves the other inbox.
	test("nobody, when the order is placed under a different email", async () => {
		const ada = await signedIn("ada@example.com");
		expect(await owner(ada.token, "grace@example.com")).toBeUndefined();
	});

	test("nobody, for an unknown or revoked session, or one whose customer is gone", async () => {
		expect(await owner("not-a-session", "ada@example.com")).toBeUndefined();
		const ada = await signedIn("ada@example.com");
		await sessionStore.revoke(ada.token);
		expect(await owner(ada.token, "ada@example.com")).toBeUndefined();
		const orphan = (await sessionStore.create("cust-gone" as CustomerId)).token;
		expect(await owner(orphan, "ada@example.com")).toBeUndefined();
	});

	// The session only decides who OWNS the order. A store that cannot answer that
	// right now must not cost the buyer the order: it becomes a guest order (the
	// next sign-in or signed-in listing claims it), and the failure is reported.
	test("a session or customer read that fails is nobody — reported, never thrown", async () => {
		const ada = await signedIn("ada@example.com");
		const boom = new Error("storage busy");
		const reported: unknown[] = [];
		const viaSessions = await checkoutOwner(
			{
				sessionStore: failing(sessionStore, "validate", boom),
				customerStore,
				onError: (err) => reported.push(err),
			},
			{ sessionToken: ada.token, buyerRef: "ada@example.com" },
		);
		const viaCustomers = await checkoutOwner(
			{
				sessionStore,
				customerStore: failing(customerStore, "get", boom),
				onError: (err) => reported.push(err),
			},
			{ sessionToken: ada.token, buyerRef: "ada@example.com" },
		);
		expect(viaSessions).toBeUndefined();
		expect(viaCustomers).toBeUndefined();
		expect(reported).toEqual([boom, boom]);
	});
});

describe("listCustomerOrders — a signed-in shopper's own orders", () => {
	test("claims the guest orders placed under their email, then lists them newest first", async () => {
		const ada = await customer("ada@example.com");
		await orderStore.createFromCart(order("ord-guest", "ADA@example.com"));
		clock.advance(1000);
		await orderStore.createFromCart(order("ord-owned", "ada@example.com", ada));

		const listed = await listCustomerOrders({ customerStore, orderStore }, ada);
		expect(listed?.map((o) => o.id)).toEqual(["ord-owned", "ord-guest"]);
		// The claim is durable, exactly as a sign-in's: the order is now this customer's.
		expect((await orderStore.getById(orderId("ord-guest")))?.customerId).toBe(ada);
	});

	test("never claims another email's guest order", async () => {
		const ada = await customer("ada@example.com");
		await orderStore.createFromCart(order("ord-grace", "grace@example.com"));
		expect(await listCustomerOrders({ customerStore, orderStore }, ada)).toEqual([]);
		expect((await orderStore.getById(orderId("ord-grace")))?.customerId).toBeNull();
	});

	test("is idempotent: listing again claims nothing new and returns the same list", async () => {
		const ada = await customer("ada@example.com");
		await orderStore.createFromCart(order("ord-guest", "ada@example.com"));
		const first = await listCustomerOrders({ customerStore, orderStore }, ada);
		const second = await listCustomerOrders({ customerStore, orderStore }, ada);
		expect(second?.map((o) => o.id)).toEqual(first?.map((o) => o.id));
		expect(await orderStore.linkGuestOrders(ada, "ada@example.com")).toBe(0);
	});

	// A session whose customer is gone is not a customer: `null`, which the caller
	// answers exactly as it answers an unusable session — never an empty list that
	// reads as "signed in, no orders".
	test("an unknown customer is null — not signed in — and claims nothing", async () => {
		await orderStore.createFromCart(order("ord-guest", "ada@example.com"));
		expect(
			await listCustomerOrders({ customerStore, orderStore }, "cust-gone" as CustomerId),
		).toBeNull();
		expect((await orderStore.getById(orderId("ord-guest")))?.customerId).toBeNull();
	});

	// The claim is a convenience riding on a READ: a store too busy to take its
	// writes must not cost the shopper their list. The failure is reported, and the
	// orders already theirs are listed; the next listing claims again.
	test("a claim that fails still lists the customer's own orders, and reports the failure", async () => {
		const ada = await customer("ada@example.com");
		await orderStore.createFromCart(order("ord-owned", "ada@example.com", ada));
		await orderStore.createFromCart(order("ord-guest", "ada@example.com"));
		const busy = new Error("compare-and-set budget exhausted");
		const failingStore = failing(orderStore, "linkGuestOrders", busy);
		const reported: unknown[] = [];
		const listed = await listCustomerOrders(
			{ customerStore, orderStore: failingStore, onClaimError: (err) => reported.push(err) },
			ada,
		);
		expect(listed?.map((o) => o.id)).toEqual(["ord-owned"]);
		expect(reported).toEqual([busy]);
		expect((await orderStore.getById(orderId("ord-guest")))?.customerId).toBeNull();
	});
});
