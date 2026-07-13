import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { CreateOrderInput, OrderStore } from "../ports/order-store.js";
import type { SeedOrderSummaryRow } from "./in-memory-order-store.js";

export interface OrderStoreHarness {
	store: OrderStore;
	/** Seed a bare order row (orders + order_totals) with an EXACT
	 *  `createdAt`/`state`/`buyerRef`/`total` for the admin-list contract. The fake
	 *  wraps `InMemoryOrderStore.seedSummaryOrder`; the Kysely harness inserts real
	 *  rows — so fake, sqlite, and pg exercise the SAME `listOrders` spec (MOD-5). */
	seedOrder(row: SeedOrderSummaryRow): Promise<void>;
}

export interface OrderStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");

/** A summary-row seed with sensible defaults; overridable per admin-list case. */
function summaryRow(overrides: Partial<SeedOrderSummaryRow> & { id: string }): SeedOrderSummaryRow {
	return {
		state: "paid",
		currency: "USD",
		buyerRef: "buyer@example.com",
		createdAt: "2026-07-10T00:00:00.000Z",
		totalCents: 1000,
		...overrides,
	};
}

/** A valid `CreateOrderInput` with a single physical line; overridable per case. */
function physicalInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
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
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

/**
 * The reusable `OrderStore` behavioral spec (§7): create + snapshot, get,
 * idempotent replay, insert-once snapshot immutability, and legal / illegal
 * guarded transitions. Runs against the fake first, then each DB dialect.
 */
export function orderStoreContract(
	makeHarness: () => Promise<OrderStoreHarness>,
	opts: OrderStoreContractOptions,
): void {
	describe(`orderStoreContract [${opts.dialect}]`, () => {
		test("creates a pending order with line snapshots + the order_totals stub", async () => {
			const { store } = await makeHarness();
			const { created, order } = await store.createFromCart(physicalInput());
			expect(created).toBe(true);
			expect(order.state).toBe("pending");
			expect(order.lines).toHaveLength(1);
			const line = order.lines[0]!;
			expect(line.title).toBe("Widget");
			expect(line.unitPrice).toBe(500);
			expect(line.currency).toBe("USD");
			expect(line.quantity).toBe(3);
			expect(line.reservationId).toBe("res-1");
			expect(order.totals.subtotal).toBe(1500);
			expect(order.totals.total).toBe(1500);
			expect(order.totals.discount).toBe(0);
			expect(order.totals.shipping).toBe(0);
			expect(order.totals.tax).toBe(0);
		});

		test("creates an order with multiple distinct-sku lines; all persist and reload", async () => {
			const { store } = await makeHarness();
			const lines: CreateOrderInput["lines"] = [
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
				{
					productId: productId("p2"),
					sku: sku("SKU-2"),
					title: "Gadget",
					unitPrice: cents(1200),
					currency: USD,
					quantity: 1,
					fulfillmentKind: "physical",
					reservationId: reservationId("res-2"),
				},
				{
					productId: productId("p3"),
					sku: sku("SKU-3"),
					title: "Ebook",
					unitPrice: cents(999),
					currency: USD,
					quantity: 2,
					fulfillmentKind: "digital",
					reservationId: null,
				},
			];
			const { created, order } = await store.createFromCart(
				physicalInput({
					lines,
					totals: { subtotal: cents(4698), total: cents(4698), currency: USD },
				}),
			);
			expect(created).toBe(true);
			expect(order.lines).toHaveLength(3);

			// Order-insensitive assertion: the Kysely store loads order_items `ORDER BY
			// id` over RANDOM uuid ids while the fake preserves input order — so match
			// each expected line by sku, NEVER by positional index / array equality.
			const bySku = new Map(order.lines.map((l) => [l.sku, l]));
			expect([...bySku.keys()].toSorted()).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
			for (const expected of lines) {
				const got = bySku.get(expected.sku);
				expect(got).toBeDefined();
				expect(got?.productId).toBe(expected.productId);
				expect(got?.title).toBe(expected.title);
				expect(got?.unitPrice).toBe(expected.unitPrice);
				expect(got?.currency).toBe(expected.currency);
				expect(got?.quantity).toBe(expected.quantity);
				expect(got?.fulfillmentKind).toBe(expected.fulfillmentKind);
				expect(got?.reservationId).toBe(expected.reservationId);
			}
			// Every line got a distinct id (one `newId()` per line).
			expect(new Set(order.lines.map((l) => l.id)).size).toBe(3);

			// A reload returns the same membership (still order-insensitive).
			const reloaded = await store.getById(order.id);
			expect(reloaded?.lines.map((l) => l.sku).toSorted()).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
		});

		test("getById returns the created order; an unknown id is null", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			const got = await store.getById(orderId("ord-1"));
			expect(got?.id).toBe("ord-1");
			expect(await store.getById(orderId("nope"))).toBeNull();
		});

		test("replay with the same idempotency_key returns the same order (created:false)", async () => {
			const { store } = await makeHarness();
			const first = await store.createFromCart(physicalInput());
			// A replay carries a DIFFERENT fresh orderId but the same key: the store
			// must dedupe on the key and return the ORIGINAL order.
			const replay = await store.createFromCart(physicalInput({ orderId: orderId("ord-2") }));
			expect(replay.created).toBe(false);
			expect(replay.order.id).toBe(first.order.id);
			expect(replay.order.lines).toHaveLength(1);
		});

		test("getByIdempotencyKey returns the order the key minted; an unknown key is null", async () => {
			const { store } = await makeHarness();
			const { order } = await store.createFromCart(physicalInput());
			const found = await store.getByIdempotencyKey(idempotencyKey("key-1"));
			expect(found?.id).toBe(order.id);
			expect(await store.getByIdempotencyKey(idempotencyKey("key-never-used"))).toBeNull();
		});

		test("order_items are insert-once: a re-read returns the exact price/title snapshot", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			const a = await store.getById(orderId("ord-1"));
			const b = await store.getById(orderId("ord-1"));
			expect(b?.lines[0]).toEqual(a?.lines[0]);
			expect(b?.lines[0]?.unitPrice).toBe(500);
			expect(b?.lines[0]?.title).toBe("Widget");
		});

		test("markPaid transitions pending→paid once; a second markPaid is a no-op (false)", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			expect(await store.markPaid(orderId("ord-1"))).toBe(true);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("paid");
			expect(await store.markPaid(orderId("ord-1"))).toBe(false);
		});

		test("markPaid on a failed order is rejected (illegal transition → false)", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			expect(await store.markFailed(orderId("ord-1"))).toBe(true);
			expect(await store.markPaid(orderId("ord-1"))).toBe(false);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("failed");
		});

		test("expire transitions pending→expired only when hold_expires_at<=now", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			// Not yet due:
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:10:00.000Z")).toBe(false);
			// Past the deadline:
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:20:00.000Z")).toBe(true);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("expired");
			// A double expire is a no-op.
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:20:00.000Z")).toBe(false);
		});

		test("listExpirable returns only pending past-TTL orders", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			await store.createFromCart(
				physicalInput({
					orderId: orderId("ord-2"),
					idempotencyKey: idempotencyKey("key-2"),
					holdExpiresAt: "2026-07-10T00:20:00.000Z",
				}),
			);
			await store.markPaid(orderId("ord-1")); // paid ⇒ never expirable
			const ids = await store.listExpirable("2026-07-10T00:30:00.000Z");
			expect(ids).toEqual([orderId("ord-2")]);
		});

		// -- Admin Orders console: view-only keyset list --------------------------

		test("listOrders on an empty store returns no rows and a null cursor", async () => {
			const { store } = await makeHarness();
			const res = await store.listOrders({}, { limit: 25 });
			expect(res.orders).toEqual([]);
			expect(res.nextCursor).toBeNull();
		});

		test("listOrders projects the summary fields (money as Cents, reconciliation as a boolean badge)", async () => {
			const h = await makeHarness();
			await h.seedOrder(
				summaryRow({
					id: "ord-proj",
					state: "shipped",
					currency: "EUR",
					buyerRef: "Jane@Example.com",
					paymentMethod: "x402",
					customerId: "cust-1",
					createdAt: "2026-07-10T01:00:00.000Z",
					totalCents: 4200,
					reconciliationFlag: "stock lost",
				}),
			);
			const { orders } = await h.store.listOrders({}, { limit: 25 });
			expect(orders).toHaveLength(1);
			const s = orders[0]!;
			expect(s.id).toBe("ord-proj");
			expect(s.state).toBe("shipped");
			expect(s.currency).toBe("EUR");
			expect(s.buyerRef).toBe("Jane@Example.com");
			expect(s.paymentMethod).toBe("x402");
			expect(s.customerId).toBe("cust-1");
			expect(s.createdAt).toBe("2026-07-10T01:00:00.000Z");
			expect(s.total).toBe(4200);
			expect(s.reconciliationFlag).toBe(true);
		});

		test("listOrders filters by a single state", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "a", state: "paid" }));
			await h.seedOrder(summaryRow({ id: "b", state: "cancelled" }));
			await h.seedOrder(summaryRow({ id: "c", state: "paid" }));
			const { orders } = await h.store.listOrders({ states: ["paid"] }, { limit: 25 });
			expect(orders.map((o) => o.id).toSorted()).toEqual(["a", "c"]);
			expect(orders.every((o) => o.state === "paid")).toBe(true);
		});

		test("listOrders filters by multiple states (IN set)", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "a", state: "paid" }));
			await h.seedOrder(summaryRow({ id: "b", state: "shipped" }));
			await h.seedOrder(summaryRow({ id: "c", state: "cancelled" }));
			await h.seedOrder(summaryRow({ id: "d", state: "refunded" }));
			const { orders } = await h.store.listOrders({ states: ["paid", "shipped"] }, { limit: 25 });
			expect(orders.map((o) => o.id).toSorted()).toEqual(["a", "b"]);
		});

		test("listOrders with no filter orders by created_at DESC, then id DESC", async () => {
			const h = await makeHarness();
			// Two share a created_at (tie broken by id DESC); a third is older.
			await h.seedOrder(summaryRow({ id: "ord-a", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedOrder(summaryRow({ id: "ord-b", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedOrder(summaryRow({ id: "ord-c", createdAt: "2026-07-10T00:00:01.000Z" }));
			const { orders } = await h.store.listOrders({}, { limit: 25 });
			// Same created_at ⇒ id DESC (ord-b before ord-a); older ord-c last.
			expect(orders.map((o) => o.id)).toEqual(["ord-b", "ord-a", "ord-c"]);
		});

		test("listOrders date window is half-open [from, to): from inclusive, to exclusive", async () => {
			const h = await makeHarness();
			const from = "2026-07-10T00:00:00.000Z";
			const to = "2026-07-11T00:00:00.000Z";
			await h.seedOrder(summaryRow({ id: "at-from", createdAt: from })); // included
			await h.seedOrder(summaryRow({ id: "inside", createdAt: "2026-07-10T12:00:00.000Z" }));
			await h.seedOrder(summaryRow({ id: "at-to", createdAt: to })); // EXCLUDED (exclusive)
			await h.seedOrder(summaryRow({ id: "before", createdAt: "2026-07-09T23:59:59.999Z" }));
			const { orders } = await h.store.listOrders({ from, to }, { limit: 25 });
			expect(orders.map((o) => o.id).toSorted()).toEqual(["at-from", "inside"]);
		});

		test("listOrders search matches an exact order id", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "ord-find-me", buyerRef: "a@x.com" }));
			await h.seedOrder(summaryRow({ id: "ord-other", buyerRef: "b@x.com" }));
			const { orders } = await h.store.listOrders({ search: "ord-find-me" }, { limit: 25 });
			expect(orders.map((o) => o.id)).toEqual(["ord-find-me"]);
		});

		test("listOrders search matches buyer_ref case-insensitively (exact, not substring)", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "a", buyerRef: "Buyer@Example.com" }));
			await h.seedOrder(summaryRow({ id: "b", buyerRef: "someone-else@example.com" }));
			const { orders } = await h.store.listOrders({ search: "buyer@example.com" }, { limit: 25 });
			expect(orders.map((o) => o.id)).toEqual(["a"]);
			// A substring of a buyer_ref must NOT match (exact-lower-equals only).
			const partial = await h.store.listOrders({ search: "buyer" }, { limit: 25 });
			expect(partial.orders).toHaveLength(0);
		});

		test("listOrders paginates forward with a keyset cursor — no overlap, no gap", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "o1", createdAt: "2026-07-10T00:00:01.000Z" }));
			await h.seedOrder(summaryRow({ id: "o2", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedOrder(summaryRow({ id: "o3", createdAt: "2026-07-10T00:00:03.000Z" }));
			// Newest-first: o3, o2, o1.
			const page1 = await h.store.listOrders({}, { limit: 2 });
			expect(page1.orders.map((o) => o.id)).toEqual(["o3", "o2"]);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.nextCursor?.id).toBe("o2"); // last returned row
			const page2 = await h.store.listOrders({}, { limit: 2, cursor: page1.nextCursor });
			expect(page2.orders.map((o) => o.id)).toEqual(["o1"]); // remainder
			expect(page2.nextCursor).toBeNull();
			// No overlap, no gap: the two pages concatenate to the full DESC order.
			expect([...page1.orders, ...page2.orders].map((o) => o.id)).toEqual(["o3", "o2", "o1"]);
		});

		test("listOrders keyset tie-break is stable across a page boundary on identical created_at", async () => {
			const h = await makeHarness();
			const at = "2026-07-10T00:00:05.000Z";
			for (const id of ["ord-01", "ord-02", "ord-03", "ord-04"]) {
				await h.seedOrder(summaryRow({ id, createdAt: at }));
			}
			// All share created_at ⇒ pure id DESC: ord-04, ord-03, ord-02, ord-01.
			const page1 = await h.store.listOrders({}, { limit: 2 });
			expect(page1.orders.map((o) => o.id)).toEqual(["ord-04", "ord-03"]);
			expect(page1.nextCursor).toEqual({ createdAt: at, id: "ord-03" });
			const page2 = await h.store.listOrders({}, { limit: 2, cursor: page1.nextCursor });
			expect(page2.orders.map((o) => o.id)).toEqual(["ord-02", "ord-01"]);
			expect(page2.nextCursor).toBeNull();
		});

		test("listOrders with rows exactly equal to the limit returns a null cursor (no phantom page)", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "o1", createdAt: "2026-07-10T00:00:01.000Z" }));
			await h.seedOrder(summaryRow({ id: "o2", createdAt: "2026-07-10T00:00:02.000Z" }));
			const res = await h.store.listOrders({}, { limit: 2 });
			expect(res.orders.map((o) => o.id)).toEqual(["o2", "o1"]);
			expect(res.nextCursor).toBeNull();
		});
	});
}
