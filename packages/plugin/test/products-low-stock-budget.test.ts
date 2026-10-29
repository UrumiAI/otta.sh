import { productId as toProductId, sku as toSku } from "@urumi.ai/otta-domain";
import {
	collectionOf,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	newShellProductDoc,
	PRODUCT_COMMERCE_COLLECTION,
	publishKeyFor,
	SKU_OWNERS_COLLECTION,
	type InventoryDoc,
	type ProductCommerceDoc,
	type SkuOwnerDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { describe, expect, test } from "vitest";
import { InProcessAdminProductsClient } from "../src/admin/in-process-admin-products-client.js";
import type {
	ProductsListFilter,
	ProductSummaryWire,
} from "../src/admin/admin-products-surface.js";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../src/types.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

/**
 * The Pricing & inventory "Low stock only" filter's STORAGE-READ budget, over a
 * real document store whose every call is counted (issue #600).
 *
 * The filter used to read one `inventory` document per scanned product, and the
 * page's list and its count each scanned the catalogue with their own cache, so
 * a catalogue with few low rows cost about two reads per product. Workers Free
 * allows 50 queries per invocation, so the filter failed past ~25 products. The
 * matching set is now resolved once per request, shared by the list and the
 * count, and the stock is read the cheaper way: a `get` per candidate sku, or
 * the whole `inventory` collection paged into a map.
 */

const THRESHOLD = 5;

async function freshStorage(): Promise<StorageAccess> {
	return (await makeSqliteStorage(commerceStorageLayout())).storage;
}

interface Counts {
	/** Every storage call AND every kv call: on the host each is a query. */
	total: number;
	/** Calls on `inventory`, by method. */
	inventory: Record<string, number>;
}

/**
 * A context over `storage` whose every storage and kv call is counted. `fault`,
 * when set, is consulted before each `inventory` call and may throw instead.
 */
function countedContext(
	storage: StorageAccess,
	fault?: (method: string) => void,
): { ctx: PluginContext; counts: Counts } {
	const counts: Counts = { total: 0, inventory: {} };
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(storage)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					counts.total++;
					if (name === INVENTORY_COLLECTION) {
						const method = String(prop);
						counts.inventory[method] = (counts.inventory[method] ?? 0) + 1;
						fault?.(method);
					}
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	const bump = async (): Promise<null> => {
		counts.total++;
		return null;
	};
	const ctx = {
		http: {
			fetch() {
				throw new Error("no egress");
			},
		},
		kv: { get: bump, set: bump, delete: bump, list: async () => (await bump()) ?? [] },
		storage: wrapped,
	} as unknown as PluginContext;
	return { ctx, counts };
}

function countedClient(storage: StorageAccess): {
	client: InProcessAdminProductsClient;
	counts: Counts;
} {
	const { ctx, counts } = countedContext(storage);
	return { client: new InProcessAdminProductsClient(ctx), counts };
}

/** `count` inventory documents no product row owns (a variant's, or an orphan's). */
async function seedUnownedStock(
	storage: StorageAccess,
	prefix: string,
	count: number,
	onHand: number,
): Promise<void> {
	const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	for (let i = 0; i < count; i++) {
		const sku = `${prefix}-${String(i).padStart(5, "0")}`;
		await inventory.put(sku, newInventoryDoc(sku, onHand));
	}
}

function reset(counts: Counts): void {
	counts.total = 0;
	counts.inventory = {};
}

interface Seed {
	id: string;
	sku: string | null;
	/** Absent ⇒ no inventory document at all (unknown stock). */
	onHand?: number;
	createdAt: string;
	active?: boolean;
	productKind?: "physical" | "digital";
	deleted?: boolean;
}

/** Writes the same documents the adapters write, with an exact `createdAt`. */
async function seed(storage: StorageAccess, rows: readonly Seed[]): Promise<void> {
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const owners = collectionOf<SkuOwnerDoc>(storage, SKU_OWNERS_COLLECTION);
	const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	for (const row of rows) {
		const deletedAt = row.deleted === true ? row.createdAt : null;
		const active = row.active ?? true;
		const doc: ProductCommerceDoc = {
			...newShellProductDoc(toProductId(row.id), row.createdAt),
			lifecycle: deletedAt === null ? "live" : "deleted",
			sku: row.sku === null ? null : toSku(row.sku),
			title: `Product ${row.id}`,
			productKind: row.productKind ?? "physical",
			active,
			publishKey: publishKeyFor(active),
			deletedAt,
			createdAt: row.createdAt,
			updatedAt: row.createdAt,
		};
		await products.put(row.id, doc);
		if (row.sku !== null && deletedAt === null) {
			await owners.put(row.sku, {
				sku: row.sku,
				ownerKind: "product",
				ownerId: doc.productId,
				variantKey: null,
				live: true,
				claimedAt: row.createdAt,
			});
		}
		if (row.sku !== null && row.onHand !== undefined) {
			await inventory.put(row.sku, newInventoryDoc(row.sku, row.onHand));
		}
	}
}

function at(minute: number): string {
	return new Date(Date.UTC(2026, 6, 10, 0, minute)).toISOString();
}

/** Every page of the filtered walk, in order, with the total each page reported. */
async function walk(
	client: InProcessAdminProductsClient,
	filter: ProductsListFilter,
	limit: number,
): Promise<{ rows: ProductSummaryWire[]; totals: (number | undefined)[] }> {
	const rows: ProductSummaryWire[] = [];
	const totals: (number | undefined)[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 100; guard++) {
		const page = await client.listProducts(filter, { cursor, limit });
		rows.push(...page.products);
		totals.push(page.total);
		if (page.nextCursor === null) return { rows, totals };
		cursor = page.nextCursor;
	}
	throw new Error("the walk did not end");
}

describe("the Low stock only filter resolves its stock once per request (#600)", () => {
	test("60 products with 2 low: one page and its total in under 50 storage calls", async () => {
		const storage = await freshStorage();
		await seed(
			storage,
			Array.from({ length: 60 }, (_, i) => ({
				id: `p-${String(i).padStart(2, "0")}`,
				sku: `SKU-${String(i).padStart(2, "0")}`,
				onHand: i === 7 || i === 41 ? 2 : 50,
				createdAt: at(i),
			})),
		);
		const { client, counts } = countedClient(storage);

		const page = await client.listProducts({ lowStockThreshold: THRESHOLD }, { limit: 25 });

		expect(page.products.map((p) => p.productId)).toEqual(["p-41", "p-07"]);
		expect(page.products.map((p) => p.onHand)).toEqual([2, 2]);
		expect(page.total).toBe(2);
		expect(page.nextCursor).toBeNull();
		expect(counts.total).toBeLessThan(50);
		// Pinned: the inventory count, one product page and ONE inventory page,
		// shared by the list and the count. Resolving twice would make this 6.
		expect(counts.total).toBe(3);
		expect(counts.inventory).toEqual({ count: 1, query: 1 });
	});

	test("a variant-heavy catalogue pays no stock read for products without a sku", async () => {
		const storage = await freshStorage();
		await seed(
			storage,
			Array.from({ length: 30 }, (_, i) => ({ id: `v-${String(i)}`, sku: null, createdAt: at(i) })),
		);
		// The variants' stock, all of it low: never a product-row match.
		await seedUnownedStock(storage, "VAR", 400, 1);
		const { client, counts } = countedClient(storage);

		const page = await client.listProducts({ lowStockThreshold: THRESHOLD }, { limit: 25 });

		expect(page.products).toEqual([]);
		expect(page.total).toBe(0);
		// The inventory count and one product page — never the ⌈400/100⌉ map.
		expect(counts.inventory).toEqual({ count: 1 });
		expect(counts.total).toBe(2);
	});

	test("a narrow search on a large inventory reads only the candidates' stock", async () => {
		const storage = await freshStorage();
		await seed(storage, [
			...Array.from({ length: 60 }, (_, i) => ({
				id: `p-${String(i)}`,
				sku: `SKU-${String(i)}`,
				onHand: 1,
				createdAt: at(i),
			})),
			{ id: "needle-low", sku: "NEEDLE-LOW", onHand: 2, createdAt: at(70) },
			{ id: "needle-high", sku: "NEEDLE-HIGH", onHand: 90, createdAt: at(71) },
		]);
		await seedUnownedStock(storage, "VAR", 1500, 1);
		const { client, counts } = countedClient(storage);

		const page = await client.listProducts(
			{ search: "needle", lowStockThreshold: THRESHOLD },
			{ limit: 25 },
		);

		expect(page.products.map((p) => [p.productId, p.onHand])).toEqual([["needle-low", 2]]);
		expect(page.total).toBe(1);
		// Two candidates cost two reads, not the ⌈1562/100⌉ map pages.
		expect(counts.inventory).toEqual({ count: 1, get: 2 });
		expect(counts.total).toBe(4);
	});

	test("a mixed catalogue lists and counts exactly what a per-product stock read decides, under both strategies", async () => {
		const storage = await freshStorage();
		const rows: Seed[] = [
			{ id: "zero", sku: "SKU-ZERO", onHand: 0, createdAt: at(1) },
			{ id: "boundary", sku: "SKU-BOUNDARY", onHand: THRESHOLD, createdAt: at(2) },
			{ id: "over", sku: "SKU-OVER", onHand: THRESHOLD + 1, createdAt: at(3) },
			{ id: "no-doc", sku: "SKU-NO-DOC", createdAt: at(4) },
			{ id: "no-sku", sku: null, createdAt: at(5) },
			{ id: "inactive-low", sku: "SKU-INACTIVE", onHand: 1, createdAt: at(6), active: false },
			{
				id: "digital-low",
				sku: "SKU-DIGITAL",
				onHand: 0,
				createdAt: at(7),
				productKind: "digital",
			},
			{ id: "deleted-low", sku: "SKU-DELETED", onHand: 1, createdAt: at(8), deleted: true },
			// A tie on `createdAt`: the order is decided by productId.
			{ id: "tie-a", sku: "SKU-TIE-A", onHand: 3, createdAt: at(9) },
			{ id: "tie-b", sku: "SKU-TIE-B", onHand: 4, createdAt: at(9) },
			{ id: "tie-c", sku: "SKU-TIE-C", onHand: 400, createdAt: at(9) },
		];
		for (let i = 0; i < 30; i++) {
			rows.push({
				id: `bulk-${String(i).padStart(3, "0")}`,
				sku: `SKU-BULK-${String(i).padStart(3, "0")}`,
				onHand: i % 4 === 0 ? i % 3 : 20 + i,
				createdAt: at(20 + i),
			});
		}
		await seed(storage, rows);
		await seedUnownedStock(storage, "ORPHAN", 1, 0);

		const filters = [
			{},
			{ active: true },
			{ productKind: "digital" },
			{ deleted: true },
			{ search: "bulk" },
		] satisfies ProductsListFilter[];
		const { client, counts } = countedClient(storage);
		const check = async (strategy: "map" | "get"): Promise<void> => {
			for (const filter of filters) {
				// The reference: the unfiltered walk reads each row's stock on its own,
				// so keeping the rows at or under the threshold is the per-product
				// decision the filter must reproduce.
				const reference = (await walk(client, filter, 100)).rows.filter(
					(p) => p.onHand !== null && p.onHand <= THRESHOLD,
				);
				for (const limit of [3, 25, 100]) {
					reset(counts);
					const filtered = await walk(client, { ...filter, lowStockThreshold: THRESHOLD }, limit);
					expect(filtered.rows).toEqual(reference);
					expect(new Set(filtered.totals)).toEqual(new Set([reference.length]));
					// The strategy the inventory's size forces, proven by the calls made.
					const other = strategy === "map" ? "get" : "query";
					expect(counts.inventory[strategy === "map" ? "query" : "get"] ?? 0).toBeGreaterThan(0);
					expect(counts.inventory[other]).toBeUndefined();
				}
			}
		};
		// Under 100 inventory documents one map page is never dearer than a read
		// per candidate; past every candidate count, a read per candidate is cheaper.
		await check("map");
		await seedUnownedStock(storage, "VAR", 5000, 0);
		await check("get");
	});

	test("the stock is never reused past the call that read it", async () => {
		const storage = await freshStorage();
		await seed(storage, [
			{ id: "a", sku: "SKU-A", onHand: 1, createdAt: at(1) },
			{ id: "b", sku: "SKU-B", onHand: 50, createdAt: at(2) },
		]);
		const { client } = countedClient(storage);
		const filter = { lowStockThreshold: THRESHOLD };

		const before = await client.listProducts(filter, { limit: 25 });
		expect(before.products.map((p) => p.productId)).toEqual(["a"]);

		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		await inventory.put("SKU-A", newInventoryDoc("SKU-A", 50));
		await inventory.put("SKU-B", newInventoryDoc("SKU-B", 2));

		const after = await client.listProducts(filter, { limit: 25 });
		expect(after.products.map((p) => [p.productId, p.onHand])).toEqual([["b", 2]]);
		expect(after.total).toBe(1);
	});

	test("a failed stock read fails the list and the count that shared it, and the next call reads afresh", async () => {
		const storage = await freshStorage();
		await seed(storage, [{ id: "a", sku: "SKU-A", onHand: 1, createdAt: at(1) }]);
		let failures = 1;
		const { ctx } = countedContext(storage, () => {
			if (failures > 0) {
				failures--;
				throw new Error("inventory unavailable");
			}
		});
		const store = createInProcessCommerceStores(ctx).productCommerce;
		const filter = { lowStockThreshold: THRESHOLD };

		const failed = await Promise.allSettled([
			store.listProducts(filter, { limit: 25 }),
			store.countProducts(filter),
		]);
		expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);

		const [page, total] = await Promise.all([
			store.listProducts(filter, { limit: 25 }),
			store.countProducts(filter),
		]);
		expect(page.products.map((p) => p.productId)).toEqual(["a"]);
		expect(total).toBe(1);
	});
});
