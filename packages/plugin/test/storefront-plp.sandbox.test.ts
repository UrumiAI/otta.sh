import {
	cents,
	currency,
	idempotencyKey,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/**
 * Phase 2 §7 step 10 — PLP wiring (plugin-owned public route per ADR-0003),
 * including the headline N+1 proof.
 *
 * WHAT THE N+1 PROOF IS NOW. It used to be an HTTP call count: one page render ⇒
 * exactly ONE commerce-batch request to the commerce service, and ZERO requests
 * to any inventory-only endpoint. INC-D3a deleted that transport — the route
 * reads `product_commerce` in-process over `ctx.storage` — so counting requests
 * would count nothing and prove nothing. The property SURVIVES one layer down
 * and is asserted there instead: one page render issues exactly ONE
 * `product_commerce.query` carrying the whole page's ids, and ZERO per-id
 * `product_commerce.get`s. That is the same claim the batch call was making,
 * against the thing that now does the work.
 *
 * THE INVENTORY HALF CHANGED SHAPE, and is stated honestly rather than dropped.
 * "Zero inventory calls" was a claim about ROUND TRIPS TO A SERVICE: `inStock`
 * arrived joined onto the batch response instead of costing a second hop. The
 * join is still intra-store — the same adapter, the same database, inside the
 * page's one read pass — but it is a document read per DISTINCT SKU, memoized
 * per pass by the store's own stock reader. So the surviving invariant is that
 * the stock reads are bounded by the page's distinct skus and never duplicated,
 * which is what the cases below pin.
 *
 * HOW THE COUNTING WORKS. The isolate's `ctx.storage` is a proxy to the store
 * this process owns (see `sandbox/storage-bridge.ts`), and the bridge looks each
 * collection up on that object per call — so wrapping two of its collections
 * here records every operation the plugin performs inside workerd, with nothing
 * added to `src/`.
 *
 * All three PLP entry points — all-products, taxonomy-filtered, and
 * search-result — share this ONE render path (§5): they differ only in
 * which tier-① CMS query produced the page of content (run outside the
 * plugin, per ADR-0003), which arrives on the route input.
 */

interface SeedProduct {
	readonly id: string;
	readonly sku: string;
	readonly amount: number;
	readonly currency: string;
	readonly onHand: number;
	/** New rows are born behind the publish gate; a purchasable fixture is
	 *  activated exactly as `content:afterPublish` activates it in a deploy. */
	readonly active?: boolean;
}

/** One operation log per instrumented collection. */
interface CollectionCalls {
	readonly queries: unknown[];
	readonly gets: string[];
	reset(): void;
}

const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

let sandboxHandle: SandboxHandle;
let storage: StorageAccess;
let productCalls: CollectionCalls;
let inventoryCalls: CollectionCalls;

function contentItem(id: string): Record<string, unknown> {
	return {
		id,
		title: `Product ${id}`,
		slug: `product-${id}`,
		description: `Description of ${id}`,
	};
}

/**
 * Replace one collection on the shared store with a recording proxy. Every
 * method still reaches the real repository — this only observes, so the suite
 * keeps running against the real database.
 */
function instrument(name: string): CollectionCalls {
	const target = storage[name];
	if (target === undefined) throw new Error(`no '${name}' collection to instrument`);
	const queries: unknown[] = [];
	const gets: string[] = [];
	storage[name] = new Proxy(target, {
		get(_holder, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== "function") return value;
			const bound = (value as (...args: unknown[]) => unknown).bind(target);
			if (property === "query") {
				return (...args: unknown[]) => {
					queries.push(args[0]);
					return bound(...args);
				};
			}
			if (property === "get") {
				return (...args: unknown[]) => {
					gets.push(String(args[0]));
					return bound(...args);
				};
			}
			return bound;
		},
	}) as (typeof storage)[string];
	return {
		queries,
		gets,
		reset() {
			queries.length = 0;
			gets.length = 0;
		},
	};
}

/** The ids one `product_commerce.query` asked for, in the order it asked. */
function queriedIds(call: unknown): string[] {
	const where = (call as { where?: { productId?: { in?: string[] } } }).where;
	return where?.productId?.in ?? [];
}

async function seedProduct(product: SeedProduct): Promise<void> {
	const commerce = new EmdashProductCommerceStore({ storage, clock: systemClock });
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	await commerce.upsert(
		{
			productId: toProductId(product.id),
			sku: toSku(product.sku),
			price: { amount: cents(product.amount), currency: currency(product.currency) },
			title: `Product ${product.id}`,
		},
		idempotencyKey(`seed-${product.id}`),
	);
	await inventory.seedOnHand(toSku(product.sku), product.onHand);
	if (product.active !== false) {
		await commerce.activate(
			toProductId(product.id),
			idempotencyKey(`pub-${product.id}`),
			PUBLISHED_AT,
		);
	}
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	productCalls = instrument(PRODUCT_COMMERCE_COLLECTION);
	inventoryCalls = instrument(INVENTORY_COLLECTION);
	// NO allowed hosts: in-process commerce reaches the network for nothing, so
	// an empty allowlist is the honest production shape AND a guard — a stray
	// `ctx.http` call would throw rather than quietly succeed.
	sandboxHandle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 120_000);

afterAll(async () => {
	await sandboxHandle?.close();
});

beforeEach(() => {
	// Seeding runs through the same instrumented collections, so the counters are
	// cleared immediately before each render rather than after each case.
	productCalls.reset();
	inventoryCalls.reset();
});

async function renderList(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	const outcome = await sandboxHandle.invokeRoute("storefront/list", input);
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

describe("storefront PLP route (workerd sandbox)", () => {
	const PAGE_IDS = Array.from({ length: 25 }, (_, i) => `plp-page-${i}`);

	test("rendering a PLP page of 25 products issues exactly ONE batched commerce read", async () => {
		for (const [index, id] of PAGE_IDS.entries()) {
			await seedProduct({
				id,
				sku: `SKU-${id}`,
				amount: 100 + index,
				currency: "USD",
				onHand: 3,
			});
		}
		productCalls.reset();
		inventoryCalls.reset();

		const result = await renderList({ items: PAGE_IDS.map(contentItem), locale: "en-US" });

		expect(result["ok"]).toBe(true);
		expect(result["items"]).toHaveLength(25);

		// THE N+1 proof (§1 case 4): one page, one batched read — not 25 lookups.
		expect(productCalls.queries).toHaveLength(1);
		expect(queriedIds(productCalls.queries[0])).toEqual(PAGE_IDS);
		expect(productCalls.gets).toHaveLength(0);
	}, 60_000);

	test("invariant guard: the stock signal is joined INSIDE the one read pass — one document read per distinct sku, never a second pass over the page", async () => {
		await seedProduct({ id: "plp-a", sku: "SKU-PLP-A", amount: 100, currency: "USD", onHand: 4 });
		await seedProduct({ id: "plp-b", sku: "SKU-PLP-B", amount: 200, currency: "USD", onHand: 0 });
		productCalls.reset();
		inventoryCalls.reset();

		const result = await renderList({
			items: ["plp-a", "plp-b"].map(contentItem),
			locale: "en-US",
		});

		// The §6 intra-store-join invariant as it now stands: the page costs ONE
		// commerce query plus exactly one stock read per distinct sku — no second
		// round over the page, and no per-product re-read.
		expect(productCalls.queries).toHaveLength(1);
		// SORTED, because the claim is ONE READ PER DISTINCT SKU and not a read
		// order: the join issues the page's stock reads concurrently, so the log's
		// order is settlement order and asserting it raw makes this case flake on a
		// property nothing depends on. Sorting keeps both halves that DO matter —
		// which skus were read, and that none was read twice.
		expect(inventoryCalls.gets.toSorted()).toEqual(["SKU-PLP-A", "SKU-PLP-B"]);

		// THE COMBINED COUNT, restored. The transport-era form of this case asserted
		// `stubServer.requests` had length 1 — a claim about the page's TOTAL cost,
		// not just about the shape of the one call it expected. Asserting the two
		// logs separately lets a THIRD kind of read appear (a per-id
		// `product_commerce.get`, an inventory `query` scanning the collection)
		// without any existing expectation noticing, which is precisely the N+1
		// regression this case exists to catch. So the total is pinned too, and the
		// two reads that are not supposed to happen at all are pinned at zero:
		expect(productCalls.gets).toHaveLength(0);
		expect(inventoryCalls.queries).toHaveLength(0);
		expect(
			productCalls.queries.length +
				productCalls.gets.length +
				inventoryCalls.queries.length +
				inventoryCalls.gets.length,
		).toBe(3); // 1 commerce query + 1 stock read per distinct sku (2)

		// And the stock signal is demonstrably what the join produced.
		const items = result["items"] as Array<Record<string, unknown>>;
		expect(items.find((i) => i["id"] === "plp-a")?.["availability"]).toBe("in_stock");
		expect(items.find((i) => i["id"] === "plp-b")?.["availability"]).toBe("out_of_stock");
	});

	test("a taxonomy-filtered PLP narrows the CMS content set BEFORE the single batched read (the read carries only the narrowed ids)", async () => {
		// The tier-① taxonomy query (category=bottles) already narrowed the
		// catalog to two ids — the plugin must scope its one read to exactly
		// that page, never expanding back to the full catalog.
		await seedProduct({
			id: "plp-bottle-1",
			sku: "SKU-B1",
			amount: 100,
			currency: "USD",
			onHand: 2,
		});
		await seedProduct({
			id: "plp-bottle-2",
			sku: "SKU-B2",
			amount: 200,
			currency: "USD",
			onHand: 2,
		});
		productCalls.reset();

		const result = await renderList({
			items: [contentItem("plp-bottle-1"), contentItem("plp-bottle-2")],
			query: { kind: "taxonomy", taxonomy: "category", term: "bottles" },
			locale: "en-US",
		});

		expect(result["ok"]).toBe(true);
		expect(result["query"]).toEqual({ kind: "taxonomy", taxonomy: "category", term: "bottles" });
		expect(productCalls.queries).toHaveLength(1);
		expect(queriedIds(productCalls.queries[0])).toEqual(["plp-bottle-1", "plp-bottle-2"]);
	});

	test("a search-result PLP (FTS) narrows the CMS content set BEFORE the single batched read", async () => {
		await seedProduct({ id: "plp-hit-1", sku: "SKU-H1", amount: 100, currency: "USD", onHand: 1 });
		productCalls.reset();

		const result = await renderList({
			items: [contentItem("plp-hit-1")],
			query: { kind: "search", query: "bamboo" },
			locale: "en-US",
		});

		expect(result["ok"]).toBe(true);
		expect(result["query"]).toEqual({ kind: "search", query: "bamboo" });
		expect(productCalls.queries).toHaveLength(1);
		expect(queriedIds(productCalls.queries[0])).toEqual(["plp-hit-1"]);
	});

	test("non-purchasable products still appear in the listing, flagged, without a price slot (shown, not filtered) — both the no-commerce AND the inactive kind", async () => {
		await seedProduct({
			id: "plp-priced",
			sku: "SKU-P",
			amount: 1999,
			currency: "USD",
			onHand: 3,
		});
		// plp-unpriced is never seeded — the batched read simply omits it.
		// plp-inactive is commerce-complete but unpublished (§4.2's "or explicitly
		// inactive" arm): a row that was never activated.
		await seedProduct({
			id: "plp-inactive",
			sku: "SKU-I",
			amount: 500,
			currency: "USD",
			onHand: 3,
			active: false,
		});

		const result = await renderList({
			items: [contentItem("plp-priced"), contentItem("plp-unpriced"), contentItem("plp-inactive")],
			locale: "en-US",
		});

		const items = result["items"] as Array<Record<string, unknown>>;
		expect(items).toHaveLength(3);

		const priced = items.find((i) => i["id"] === "plp-priced");
		expect(priced).toMatchObject({
			purchasable: true,
			price: { amount: 1999, currency: "USD", formatted: "$19.99" },
			availability: "in_stock",
		});

		const unpriced = items.find((i) => i["id"] === "plp-unpriced");
		expect(unpriced).toMatchObject({
			title: "Product plp-unpriced",
			purchasable: false,
			price: null,
			availability: null,
		});

		// Inactive renders EXACTLY like no-commerce: flagged, no price slot.
		const inactive = items.find((i) => i["id"] === "plp-inactive");
		expect(inactive).toMatchObject({
			title: "Product plp-inactive",
			purchasable: false,
			sku: null,
			price: null,
			availability: null,
		});
	});

	test("duplicate ids within a page collapse into the single batched read — on BOTH sides of the join", async () => {
		await seedProduct({ id: "plp-dup", sku: "SKU-D", amount: 100, currency: "USD", onHand: 1 });
		// Both logs, because both halves are under test: seeding reads inventory too.
		productCalls.reset();
		inventoryCalls.reset();

		const result = await renderList({
			items: [contentItem("plp-dup"), contentItem("plp-dup")],
		});

		expect(result["ok"]).toBe(true);
		expect(productCalls.queries).toHaveLength(1);
		expect(queriedIds(productCalls.queries[0])).toEqual(["plp-dup"]);

		// THE INVENTORY SIDE DEDUPES TOO, restored. The commerce half collapsing a
		// repeated id is only half the claim: the stock join is a document read per
		// DISTINCT sku, so a page naming one product twice must cost ONE stock read,
		// not two. Without this, the dedup could quietly move from "the page's ids
		// are deduped" to "the commerce QUERY's `in` list is deduped" — which reads
		// identically above and doubles the stock reads on every repeated row.
		expect(inventoryCalls.gets).toEqual(["SKU-D"]);
	});

	test("a page at EXACTLY the size cap (48) is accepted and still one batched read — the cap boundary is inclusive", async () => {
		// Deliberately UNSEEDED: what this case pins is the cap boundary and the
		// single read, neither of which depends on the ids resolving to rows — and
		// seeding 48 products would pay for that twice over.
		const ids = Array.from({ length: 48 }, (_, i) => `plp-cap-${i}`);

		const result = await renderList({ items: ids.map(contentItem) });

		expect(result["ok"]).toBe(true);
		expect(result["items"]).toHaveLength(48);
		expect(productCalls.queries).toHaveLength(1);
		expect(queriedIds(productCalls.queries[0])).toEqual(ids);
	});

	test("a page over the PLP size cap is a structured rejection BEFORE any commerce read (the cap keeps one page = one read)", async () => {
		const tooMany = Array.from({ length: 49 }, (_, i) => contentItem(`plp-over-${i}`));

		const result = await renderList({ items: tooMany });

		expect(result).toEqual({ ok: false, error: "PAGE_TOO_LARGE", max: 48 });
		expect(productCalls.queries).toHaveLength(0);
	});

	test("malformed items are a structured rejection before any commerce read", async () => {
		const result = await renderList({ items: [{ title: "no id" }] });

		expect(result).toEqual({ ok: false, error: "INVALID_ITEMS" });
		expect(productCalls.queries).toHaveLength(0);
	});
});
