/**
 * The search's line-sku arm, measured: its STORAGE-CALL budget, and its results against
 * the per-order path it replaced (issue #601).
 *
 * The arm used to open its orders one `get` per index pointer, and `countOrders` walks
 * every pointer a sku ever collected. Searching a best-seller on 300 orders cost about 330
 * calls; Workers Free allows 50 queries per invocation, so the Orders screen failed at
 * about 20 orders for one sku. The arm now reads each index page's orders in batches of
 * `searchKey in [...]`, so the call count grows with index PAGES, not with orders.
 *
 * The budget case pins that shape. The equivalence case is the guard on the rewrite: a
 * mixed store (multi-line matches, tie groups across page boundaries, state filters,
 * a pre-`searchKey` order, a dangling and a stale pointer) must list and count exactly
 * what the one-`get`-per-pointer oracle below resolves.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku as brandSku,
	type CreateOrderInput,
	type OrderListFilter,
	type OrderState,
	type OrderStore,
} from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	foldSku,
	normalizeOrderDoc,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	orderSkuKeys,
	ORDERS_COLLECTION,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type StorageAccess,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const USD = currency("USD");

/** An order carrying REAL frozen lines, through the port's own `createFromCart`. */
async function lined(store: OrderStore, id: string, skus: readonly string[]): Promise<void> {
	const unit = 500;
	const lines: CreateOrderInput["lines"] = skus.map((s, i) => ({
		productId: productId(`p-${id}-${String(i)}`),
		sku: brandSku(s),
		title: "Widget",
		unitPrice: cents(unit),
		currency: USD,
		quantity: 1,
		fulfillmentKind: "physical",
		reservationId: reservationId(`res-${id}-${String(i)}`),
	}));
	const total = cents(unit * skus.length);
	await store.createFromCart({
		orderId: orderId(id),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines,
		totals: { subtotal: total, total, currency: USD },
	});
}

/** Every call on every collection, counted — on the host each one is a query. */
function countedStorage(storage: StorageAccess): { storage: StorageAccess; calls: () => number } {
	let calls = 0;
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(storage)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return { storage: wrapped, calls: () => calls };
}

/** Every order id the list returns for `filter`, walked page by page to the end. */
async function walkList(
	store: OrderStore,
	filter: OrderListFilter,
	limit: number,
): Promise<string[]> {
	const ids: string[] = [];
	let cursor = null;
	for (let page = 0; page < 1000; page++) {
		const result = await store.listOrders(filter, { cursor, limit });
		ids.push(...result.orders.map((o) => o.id));
		if (result.nextCursor === null) return ids;
		cursor = result.nextCursor;
	}
	throw new Error("the list never ended");
}

/** Code-unit DESCENDING — the list's own order (`byNewestFirst`). */
function desc(a: string, b: string): number {
	return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * THE ORACLE: the sku arm as it was before #601 — every pointer for the sku, one `get`
 * per pointer, the frozen lines re-checked, the filter applied — resolved in full and
 * sorted into the list's `createdAt DESC, id DESC` code-unit order.
 */
async function perOrderOracle(
	storage: StorageAccess,
	search: string,
	states?: readonly OrderState[],
): Promise<string[]> {
	const folded = foldSku(search);
	const index = collectionOf<OrderSkuIndexDoc>(storage, ORDER_SKU_INDEX_COLLECTION);
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const docs: OrderDoc[] = [];
	let cursor: string | undefined;
	do {
		const page = await index.query({ where: { sku: folded }, limit: 100, cursor });
		for (const { data } of page.items) {
			const stored = await orders.get(data.orderId);
			if (stored === null) continue;
			const doc = normalizeOrderDoc(stored);
			if (!orderSkuKeys(doc).includes(folded)) continue;
			if (states !== undefined && !states.includes(doc.state)) continue;
			docs.push(doc);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return docs
		.toSorted((a, b) => desc(a.createdAt, b.createdAt) || desc(a.orderId, b.orderId))
		.map((doc) => doc.orderId);
}

/** Rewrite one stored order's `state` — data shaping for the filter cases. */
async function setState(storage: StorageAccess, id: string, state: OrderState): Promise<void> {
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const doc = await orders.get(id);
	if (doc === null) throw new Error(`no order ${id}`);
	await orders.put(id, { ...doc, state });
}

describeEachDialect("the line-sku search arm's storage budget", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);

	test("120 orders sharing a sku: list + count stay under 50 storage calls", async () => {
		const h: OrderHarness = makeOrderHarness(bound.storage);
		for (let i = 0; i < 120; i++) {
			await lined(h.store, `ord-${String(i).padStart(3, "0")}`, ["S1"]);
			h.advance(1000);
		}
		const counted = countedStorage(bound.storage);
		const store = makeOrderHarness(bound.storage, { storageForOrders: counted.storage }).store;

		const filter: OrderListFilter = { search: "S1" };
		const [page, total] = await Promise.all([
			store.listOrders(filter, { cursor: null, limit: 25 }),
			store.countOrders(filter),
		]);

		expect(total).toBe(120);
		// Newest first: the last order created heads the page.
		expect(page.orders.map((o) => o.id)).toEqual(
			Array.from({ length: 25 }, (_, i) => `ord-${String(119 - i).padStart(3, "0")}`),
		);
		expect(page.nextCursor).not.toBeNull();
		expect(counted.calls()).toBeLessThan(50);
	}, 120_000);

	test("the batched arm lists and counts exactly what the per-order path did", async () => {
		const h: OrderHarness = makeOrderHarness(bound.storage);
		const states: OrderState[] = ["pending", "paid", "cancelled"];
		// 130 orders, so the sku's pointers cross an index page (100) and several read
		// batches (50). A clock that moves only every third order leaves TIE GROUPS for the
		// list's page boundaries to fall inside. Every fourth order carries S1 on two lines
		// (one index pointer, one row); every fifth does not carry it at all.
		for (let i = 0; i < 130; i++) {
			const id = `ord-${String(i).padStart(3, "0")}`;
			const skus = i % 5 === 0 ? ["OTHER"] : i % 4 === 0 ? ["S1", "X", "s1"] : ["S1"];
			await lined(h.store, id, skus);
			await setState(bound.storage, id, states[i % 3]!);
			if (i % 3 === 2) h.advance(1000);
		}
		// A mixed-case id whose document predates `searchKey`: the batch's `searchKey in`
		// cannot see it, and it must still be resolved.
		await lined(h.store, "Ord-Legacy", ["S1"]);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const legacy = await orders.get("Ord-Legacy");
		await orders.put("Ord-Legacy", { ...legacy!, searchKey: null });
		// Two ids that differ only in case fold to ONE `searchKey`: one batch read returns
		// both, and each must still resolve as its own row.
		await lined(h.store, "ORD-CASE", ["S1"]);
		await lined(h.store, "ord-case", ["S1"]);
		h.advance(1000);
		// A dangling pointer (no order behind it) and a stale one (the order's lines do
		// not carry the sku): neither is a row.
		const index = collectionOf<OrderSkuIndexDoc>(bound.storage, ORDER_SKU_INDEX_COLLECTION);
		const at = legacy!.createdAt;
		await index.put(orderSkuIndexId("s1", "ord-gone"), {
			sku: "s1",
			orderId: "ord-gone",
			createdAt: at,
		});
		await index.put(orderSkuIndexId("s1", "ord-000"), {
			sku: "s1",
			orderId: "ord-000",
			createdAt: "2026-07-10T00:00:00.000Z",
		});

		const cases: { filter: OrderListFilter; states?: OrderState[] }[] = [
			{ filter: { search: "S1" } },
			{ filter: { search: "s1", states: ["paid"] }, states: ["paid"] },
			{
				filter: { search: "S1", states: ["pending", "cancelled"] },
				states: ["pending", "cancelled"],
			},
		];
		for (const { filter, states: only } of cases) {
			const expected = await perOrderOracle(bound.storage, "S1", only);
			expect(expected.length).toBeGreaterThan(20);
			for (const limit of [7, 25, 100]) {
				expect(await walkList(h.store, filter, limit)).toEqual(expected);
			}
			expect(await h.store.countOrders(filter)).toBe(expected.length);
		}
		// The legacy order and both case twins are rows under the unfiltered search.
		const all = await perOrderOracle(bound.storage, "S1");
		expect(all).toContain("Ord-Legacy");
		expect(all).toContain("ORD-CASE");
		expect(all).toContain("ord-case");
	}, 180_000);

	test("orders that predate searchKey: the list pays at most one batch read over the per-order path", async () => {
		const h: OrderHarness = makeOrderHarness(bound.storage);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		for (let i = 0; i < 60; i++) {
			const id = `old-${String(i).padStart(3, "0")}`;
			await lined(h.store, id, ["S2"]);
			const doc = await orders.get(id);
			await orders.put(id, { ...doc!, searchKey: null });
			h.advance(1000);
		}
		const counted = countedStorage(bound.storage);
		const store = makeOrderHarness(bound.storage, { storageForOrders: counted.storage }).store;

		const page = await store.listOrders({ search: "S2" }, { cursor: null, limit: 25 });

		expect(page.orders.map((o) => o.id)).toEqual(
			Array.from({ length: 25 }, (_, i) => `old-${String(59 - i).padStart(3, "0")}`),
		);
		// The per-order path cost 29 here: the id and buyer-reference arms (2), one index
		// page (1) and one `get` per order up to the `limit + 1` boundary (26). The batch
		// finds none of these orders, so each falls back to that same `get` — read lazily,
		// never for the pointers past the boundary — and the batch itself adds ONE query
		// (`ceil(26 / 50)`).
		expect(counted.calls()).toBeLessThanOrEqual(29 + 1);
	}, 120_000);
});
