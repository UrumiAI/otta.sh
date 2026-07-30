import {
	email,
	getOrderCustomerContext,
	orderId,
	type OrderCustomerContextDeps,
} from "@otta-sh/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryAddressStore,
	InMemoryCustomerStore,
	InMemoryOrderStore,
	InMemorySessionStore,
} from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

// getOrderCustomerContext (admin-UX Increment 1): pure orchestration over the
// four ports. The headline regression here is the LAZY-LINKING reality: orders
// are born customer_id=NULL and only back-linked at the customer's next login,
// so the SAME person routinely owns a linked order A and a not-yet-relinked
// order B — and the panel must show the SAME identity and the SAME counts no
// matter which of the two the admin opened.

interface Harness {
	clock: FixedClock;
	orderStore: InMemoryOrderStore;
	customerStore: InMemoryCustomerStore;
	addressStore: InMemoryAddressStore;
	sessionStore: InMemorySessionStore;
	deps: OrderCustomerContextDeps;
}

function makeHarness(recentOrdersLimit?: number): Harness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	const customerStore = new InMemoryCustomerStore({ idGen: new CountingIdGen("cust"), clock });
	const addressStore = new InMemoryAddressStore({ idGen: new CountingIdGen("addr"), clock });
	const sessionStore = new InMemorySessionStore({ idGen: new CountingIdGen("sess"), clock });
	return {
		clock,
		orderStore,
		customerStore,
		addressStore,
		sessionStore,
		deps: {
			orderStore,
			customerStore,
			addressStore,
			sessionStore,
			...(recentOrdersLimit !== undefined ? { recentOrdersLimit } : {}),
		},
	};
}

function seedOrder(
	h: Harness,
	row: { id: string; customerId?: string | null; buyerRef: string; createdAt: string },
): void {
	h.orderStore.seedSummaryOrder({
		id: row.id,
		state: "paid",
		currency: "USD",
		buyerRef: row.buyerRef,
		customerId: row.customerId ?? null,
		createdAt: row.createdAt,
		totalCents: 1000,
	});
}

describe("getOrderCustomerContext", () => {
	test("unknown order → null", async () => {
		const h = makeHarness();
		expect(await getOrderCustomerContext(h.deps, orderId("nope"))).toBeNull();
	});

	test("REGRESSION: a claimed order and a not-yet-relinked order of the SAME person yield the SAME identity and counts", async () => {
		const h = makeHarness();
		const bob = await h.customerStore.create({ email: email("bob@example.com") });
		// Order A: linked at bob's last login (buyer_ref retained, case as typed).
		seedOrder(h, {
			id: "ord-a",
			customerId: bob.id,
			buyerRef: "Bob@Example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
		});
		// Order B: placed AFTER that login — born unlinked. The common path.
		seedOrder(h, {
			id: "ord-b",
			customerId: null,
			buyerRef: "bob@example.com",
			createdAt: "2026-07-10T00:00:02.000Z",
		});

		const fromA = await getOrderCustomerContext(h.deps, orderId("ord-a"));
		const fromB = await getOrderCustomerContext(h.deps, orderId("ord-b"));

		// Same account resolved from either order — B must NOT read as a guest.
		expect(fromA?.identity.customerId).toBe(bob.id);
		expect(fromB?.identity.customerId).toBe(bob.id);
		expect(fromA?.identity.email).toBe("bob@example.com");
		expect(fromB?.identity.email).toBe("bob@example.com");
		expect(fromA?.identity.linkage).toBe("claimed");
		expect(fromB?.identity.linkage).toBe("unclaimed");
		// Same union count from either side; the OTHER order shows as recent.
		expect(fromA?.orderCount).toBe(2);
		expect(fromB?.orderCount).toBe(2);
		expect(fromA?.recentOrders.map((o) => o.id)).toEqual(["ord-b"]);
		expect(fromB?.recentOrders.map((o) => o.id)).toEqual(["ord-a"]);
	});

	test("a resolved account surfaces its addresses and token-free sessions (claimed AND unclaimed)", async () => {
		const h = makeHarness();
		const bob = await h.customerStore.create({ email: email("bob@example.com") });
		await h.addressStore.create(bob.id, {
			kind: "shipping",
			name: "Bob",
			line1: "1 Main St",
			city: "Springfield",
			postalCode: "12345",
			country: "US",
			isDefault: true,
		});
		await h.sessionStore.create(bob.id);
		seedOrder(h, {
			id: "ord-unclaimed",
			customerId: null,
			buyerRef: "bob@example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
		});

		const ctx = await getOrderCustomerContext(h.deps, orderId("ord-unclaimed"));
		expect(ctx?.identity.linkage).toBe("unclaimed");
		expect(ctx?.addresses.map((a) => a.line1)).toEqual(["1 Main St"]);
		expect(ctx?.sessions).toHaveLength(1);
		// Token-free: the summary carries exactly the four metadata fields.
		expect(Object.keys(ctx!.sessions[0]!).toSorted()).toEqual([
			"createdAt",
			"expiresAt",
			"id",
			"revokedAt",
		]);
	});

	test("true guest (no account for the buyer_ref): guest linkage, empty addresses/sessions, counts by case-folded buyer_ref", async () => {
		const h = makeHarness();
		seedOrder(h, {
			id: "ord-g1",
			buyerRef: "Stranger@Example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
		});
		seedOrder(h, {
			id: "ord-g2",
			buyerRef: "stranger@example.com",
			createdAt: "2026-07-10T00:00:02.000Z",
		});

		const ctx = await getOrderCustomerContext(h.deps, orderId("ord-g1"));
		expect(ctx?.identity).toEqual({
			customerId: null,
			buyerRef: "Stranger@Example.com",
			email: null,
			displayName: null,
			emailVerifiedAt: null,
			linkage: "guest",
		});
		expect(ctx?.addresses).toEqual([]);
		expect(ctx?.sessions).toEqual([]);
		expect(ctx?.orderCount).toBe(2); // case-insensitive buyer_ref union half
		expect(ctx?.recentOrders.map((o) => o.id)).toEqual(["ord-g2"]);
	});

	test("a non-email buyer_ref (claim token) never throws — guest context keyed on the raw ref", async () => {
		const h = makeHarness();
		seedOrder(h, {
			id: "ord-tok",
			buyerRef: "session:abc123",
			createdAt: "2026-07-10T00:00:01.000Z",
		});
		const ctx = await getOrderCustomerContext(h.deps, orderId("ord-tok"));
		expect(ctx?.identity.linkage).toBe("guest");
		expect(ctx?.identity.buyerRef).toBe("session:abc123");
		expect(ctx?.orderCount).toBe(1);
	});

	test("a dangling customer_id (customers row missing) degrades to guest-shape and still counts by BOTH keys", async () => {
		const h = makeHarness();
		seedOrder(h, {
			id: "ord-d1",
			customerId: "cust-gone",
			buyerRef: "session:xyz", // non-email: the by-email fallback finds nothing
			createdAt: "2026-07-10T00:00:01.000Z",
		});
		seedOrder(h, {
			id: "ord-d2",
			customerId: "cust-gone",
			buyerRef: "session:other",
			createdAt: "2026-07-10T00:00:02.000Z",
		});
		const ctx = await getOrderCustomerContext(h.deps, orderId("ord-d1"));
		// Honest degrade: the dangling id is surfaced, no email fabricated, no throw.
		expect(ctx?.identity.linkage).toBe("guest");
		expect(ctx?.identity.customerId).toBe("cust-gone");
		expect(ctx?.identity.email).toBeNull();
		// The union key still carries the dangling customer_id, so the sibling
		// order (same id, different ref) is counted — consistent from either order.
		expect(ctx?.orderCount).toBe(2);
	});

	test("recentOrders excludes the viewed order and caps at the limit even when the viewed order is NOT in the newest N+1", async () => {
		const h = makeHarness(2);
		// Four orders, oldest → newest. Viewing the OLDEST: it does not appear in
		// the newest limit+1=3 fetched rows, so the exclude-then-slice must still
		// return exactly 2 rows (fetch 3, self absent, slice to 2).
		for (let i = 1; i <= 4; i++) {
			seedOrder(h, {
				id: `ord-${i}`,
				buyerRef: "busy@example.com",
				createdAt: `2026-07-10T00:00:0${i}.000Z`,
			});
		}
		const fromOldest = await getOrderCustomerContext(h.deps, orderId("ord-1"));
		expect(fromOldest?.orderCount).toBe(4);
		expect(fromOldest?.recentOrders.map((o) => o.id)).toEqual(["ord-4", "ord-3"]);

		// Viewing the NEWEST: self IS in the fetched window — excluded, then the
		// next two newest fill the cap.
		const fromNewest = await getOrderCustomerContext(h.deps, orderId("ord-4"));
		expect(fromNewest?.recentOrders.map((o) => o.id)).toEqual(["ord-3", "ord-2"]);
	});
});
