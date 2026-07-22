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

		// -- customer dimension: UNION key + countOrders (admin-UX Increment 1) ----
		// Orders are born customer_id=NULL and only back-linked at the next login,
		// so ONE person routinely owns both linked rows (customer_id set) and
		// not-yet-relinked rows (customer_id NULL, matching buyer_ref). The
		// `customer` key must union the two — and `countOrders` must share the
		// exact predicate with `listOrders` so a count never disagrees with the
		// list it captions.

		/** Seed one person's split ownership: a linked order A (customer_id set,
		 *  buyer_ref retained) + a not-yet-relinked order B (customer_id NULL, same
		 *  email), plus a foreign order C. */
		async function seedSplitOwnership(h: OrderStoreHarness): Promise<void> {
			await h.seedOrder(
				summaryRow({
					id: "ord-linked",
					customerId: "cust-1",
					buyerRef: "Bob@Example.com", // stored verbatim; linking folds case
					createdAt: "2026-07-10T00:00:01.000Z",
				}),
			);
			await h.seedOrder(
				summaryRow({
					id: "ord-unlinked",
					customerId: null,
					buyerRef: "bob@example.com",
					createdAt: "2026-07-10T00:00:02.000Z",
				}),
			);
			await h.seedOrder(
				summaryRow({
					id: "ord-foreign",
					customerId: "cust-2",
					buyerRef: "carol@example.com",
					createdAt: "2026-07-10T00:00:03.000Z",
				}),
			);
		}

		test("listOrders customer key UNIONS customer_id and buyer_ref: linked + not-yet-relinked, never a foreign order", async () => {
			const h = await makeHarness();
			await seedSplitOwnership(h);
			const { orders } = await h.store.listOrders(
				{ customer: { customerId: "cust-1", buyerRef: "bob@example.com" } },
				{ limit: 25 },
			);
			// Newest-first; B (unlinked) matched via buyer_ref, A via customer_id.
			expect(orders.map((o) => o.id)).toEqual(["ord-unlinked", "ord-linked"]);
		});

		test("listOrders customer key: an order matching BOTH halves appears exactly once", async () => {
			const h = await makeHarness();
			// The linked order matches customer_id AND (case-folded) buyer_ref.
			await h.seedOrder(
				summaryRow({ id: "ord-both", customerId: "cust-1", buyerRef: "Bob@Example.com" }),
			);
			const { orders } = await h.store.listOrders(
				{ customer: { customerId: "cust-1", buyerRef: "bob@example.com" } },
				{ limit: 25 },
			);
			expect(orders.map((o) => o.id)).toEqual(["ord-both"]);
		});

		test("listOrders customer.buyerRef folds case exactly (never substring), matching search's semantics", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "a", buyerRef: "Buyer@Example.com" }));
			await h.seedOrder(summaryRow({ id: "b", buyerRef: "someone-else@example.com" }));
			const exact = await h.store.listOrders(
				{ customer: { buyerRef: "buyer@example.com" } },
				{ limit: 25 },
			);
			expect(exact.orders.map((o) => o.id)).toEqual(["a"]);
			const partial = await h.store.listOrders({ customer: { buyerRef: "buyer" } }, { limit: 25 });
			expect(partial.orders).toHaveLength(0);
		});

		test("listOrders customer key with a single half set filters on that half alone", async () => {
			const h = await makeHarness();
			await seedSplitOwnership(h);
			const byId = await h.store.listOrders({ customer: { customerId: "cust-1" } }, { limit: 25 });
			expect(byId.orders.map((o) => o.id)).toEqual(["ord-linked"]);
			const byRef = await h.store.listOrders(
				{ customer: { buyerRef: "bob@example.com" } },
				{ limit: 25 },
			);
			expect(byRef.orders.map((o) => o.id)).toEqual(["ord-unlinked", "ord-linked"]);
		});

		test("listOrders customer key ANDs with the states filter (union inside the key only)", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "paid-1", customerId: "cust-1", state: "paid" }));
			await h.seedOrder(summaryRow({ id: "refunded-1", customerId: "cust-1", state: "refunded" }));
			await h.seedOrder(summaryRow({ id: "paid-foreign", customerId: "cust-2", state: "paid" }));
			const { orders } = await h.store.listOrders(
				{ states: ["paid"], customer: { customerId: "cust-1" } },
				{ limit: 25 },
			);
			expect(orders.map((o) => o.id)).toEqual(["paid-1"]);
		});

		test("countOrders agrees with listOrders on the union customer key (and counts a both-halves order once)", async () => {
			const h = await makeHarness();
			await seedSplitOwnership(h);
			const key = { customerId: "cust-1", buyerRef: "bob@example.com" };
			expect(await h.store.countOrders({ customer: key })).toBe(2);
			// The linked order matches both halves — still one row, counted once.
			expect(await h.store.countOrders({ customer: { customerId: "cust-1" } })).toBe(1);
			expect(await h.store.countOrders({})).toBe(3); // unfiltered: every order
		});

		test("countOrders on a customer with no orders returns 0", async () => {
			const h = await makeHarness();
			await seedSplitOwnership(h);
			expect(
				await h.store.countOrders({
					customer: { customerId: "cust-none", buyerRef: "nobody@example.com" },
				}),
			).toBe(0);
		});

		test("countOrders applies the full listOrders predicate (states AND window AND customer)", async () => {
			const h = await makeHarness();
			await h.seedOrder(
				summaryRow({
					id: "in-window",
					customerId: "cust-1",
					state: "paid",
					createdAt: "2026-07-10T12:00:00.000Z",
				}),
			);
			await h.seedOrder(
				summaryRow({
					id: "out-of-window",
					customerId: "cust-1",
					state: "paid",
					createdAt: "2026-07-11T00:00:00.000Z", // at the EXCLUSIVE upper bound
				}),
			);
			await h.seedOrder(
				summaryRow({
					id: "wrong-state",
					customerId: "cust-1",
					state: "cancelled",
					createdAt: "2026-07-10T13:00:00.000Z",
				}),
			);
			expect(
				await h.store.countOrders({
					states: ["paid"],
					from: "2026-07-10T00:00:00.000Z",
					to: "2026-07-11T00:00:00.000Z",
					customer: { customerId: "cust-1" },
				}),
			).toBe(1);
		});

		// -- resolveReconciliation: equality-guarded compare-and-clear ------------

		test("resolveReconciliation clears the flag and records the disposition; state/lines untouched", async () => {
			const h = await makeHarness();
			await h.seedOrder(
				summaryRow({ id: "ord-rec", state: "paid", reconciliationFlag: "commit lost" }),
			);
			const res = await h.store.resolveReconciliation({
				orderId: orderId("ord-rec"),
				expectedFlag: "commit lost",
				outcome: "fulfilled",
				reason: "re-sourced stock from warehouse B",
				resolvedBy: "ops@shop.test",
				idempotencyKey: idempotencyKey("res-1"),
			});
			expect(res.resolved).toBe(true);
			const after = await h.store.getById(orderId("ord-rec"));
			// Flag cleared; disposition recorded; state NOT moved by the resolve.
			expect(after?.reconciliationFlag).toBeNull();
			expect(after?.state).toBe("paid");
			expect(after?.reconciliationResolution).toEqual({
				outcome: "fulfilled",
				reason: "re-sourced stock from warehouse B",
				resolvedBy: "ops@shop.test",
				resolvedAt: "2026-07-10T00:00:00.000Z", // the harness FixedClock
			});
			// The list badge flips off once the open flag is cleared.
			const { orders } = await h.store.listOrders({}, { limit: 25 });
			expect(orders.find((o) => o.id === "ord-rec")?.reconciliationFlag).toBe(false);
		});

		test("resolveReconciliation with a STALE expectedFlag is a 0-row miss: the re-flagged anomaly survives", async () => {
			const h = await makeHarness();
			// The admin reviewed "commit lost" — but a NEW anomaly re-flagged the order
			// before they submitted. The equality guard must NOT clear the new flag.
			await h.seedOrder(
				summaryRow({ id: "ord-stale", state: "paid", reconciliationFlag: "paid flip lost" }),
			);
			const res = await h.store.resolveReconciliation({
				orderId: orderId("ord-stale"),
				expectedFlag: "commit lost", // stale — the displayed flag, not the live one
				outcome: "written_off",
				reason: "reviewed the old anomaly",
				resolvedBy: "ops@shop.test",
				idempotencyKey: idempotencyKey("res-stale"),
			});
			expect(res.resolved).toBe(false);
			const after = await h.store.getById(orderId("ord-stale"));
			// The LIVE flag is untouched and no disposition was fabricated.
			expect(after?.reconciliationFlag).toBe("paid flip lost");
			expect(after?.reconciliationResolution).toBeNull();
		});

		test("resolveReconciliation on a NON-flagged order is a guarded 0-row no-op (resolved:false)", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "ord-clean", state: "paid" })); // no flag
			const res = await h.store.resolveReconciliation({
				orderId: orderId("ord-clean"),
				expectedFlag: "anything",
				outcome: "written_off",
				reason: "n/a",
				resolvedBy: "ops@shop.test",
				idempotencyKey: idempotencyKey("res-2"),
			});
			expect(res.resolved).toBe(false);
			const after = await h.store.getById(orderId("ord-clean"));
			// Nothing recorded — a resolve never fabricates a disposition on a clean order.
			expect(after?.reconciliationResolution).toBeNull();
		});

		test("resolveReconciliation is once-only: a second resolve is a 0-row no-op, disposition unchanged", async () => {
			const h = await makeHarness();
			await h.seedOrder(
				summaryRow({ id: "ord-once", state: "paid", reconciliationFlag: "paid flip lost" }),
			);
			const first = await h.store.resolveReconciliation({
				orderId: orderId("ord-once"),
				expectedFlag: "paid flip lost",
				outcome: "refunded",
				reason: "refunded the buyer, stock was gone",
				resolvedBy: "alice",
				idempotencyKey: idempotencyKey("res-3a"),
			});
			expect(first.resolved).toBe(true);
			// A second, different resolve attempt finds the flag already cleared.
			const second = await h.store.resolveReconciliation({
				orderId: orderId("ord-once"),
				expectedFlag: "paid flip lost",
				outcome: "written_off",
				reason: "different call",
				resolvedBy: "bob",
				idempotencyKey: idempotencyKey("res-3b"),
			});
			expect(second.resolved).toBe(false);
			// The FIRST disposition is authoritative — the loser never overwrote it.
			const after = await h.store.getById(orderId("ord-once"));
			expect(after?.reconciliationResolution?.outcome).toBe("refunded");
			expect(after?.reconciliationResolution?.resolvedBy).toBe("alice");
		});
	});
}
