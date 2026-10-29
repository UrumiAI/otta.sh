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
 * stock is now paged ONCE per request into a sku → on-hand map that the list and
 * the count share.
 */

const THRESHOLD = 5;

async function freshStorage(): Promise<StorageAccess> {
	return (await makeSqliteStorage(commerceStorageLayout())).storage;
}

/** A client over `storage` whose every storage and kv call bumps `counts.total`. */
function countedClient(storage: StorageAccess): {
	client: InProcessAdminProductsClient;
	counts: { total: number };
} {
	const counts = { total: 0 };
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(storage)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					counts.total++;
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
	return { client: new InProcessAdminProductsClient(ctx), counts };
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

describe("the Low stock only filter reads the stock once per request (#600)", () => {
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
		// Pinned: one product page for the list, one for the count, and ONE
		// inventory page they share. A second stock read would make this 4.
		expect(counts.total).toBe(3);
	});

	test("a mixed catalogue lists and counts exactly what a per-product stock read decides", async () => {
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
		for (let i = 0; i < 130; i++) {
			rows.push({
				id: `bulk-${String(i).padStart(3, "0")}`,
				sku: `SKU-BULK-${String(i).padStart(3, "0")}`,
				onHand: i % 9 === 0 ? i % 4 : 20 + i,
				createdAt: at(20 + i),
			});
		}
		await seed(storage, rows);
		// Stock no live product row owns (a variant's, or an orphan's) is never a
		// product match, however low.
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		await inventory.put("SKU-ORPHAN", newInventoryDoc("SKU-ORPHAN", 0));

		const { client } = countedClient(storage);
		for (const filter of [
			{},
			{ active: true },
			{ productKind: "digital" },
			{ deleted: true },
			{ search: "bulk" },
		] satisfies ProductsListFilter[]) {
			// The reference: the unfiltered walk reads each row's stock on its own, so
			// keeping the rows at or under the threshold is the per-product decision.
			const reference = (await walk(client, filter, 100)).rows.filter(
				(p) => p.onHand !== null && p.onHand <= THRESHOLD,
			);
			for (const limit of [3, 25, 100]) {
				const filtered = await walk(client, { ...filter, lowStockThreshold: THRESHOLD }, limit);
				expect(filtered.rows).toEqual(reference);
				expect(new Set(filtered.totals)).toEqual(new Set([reference.length]));
			}
		}
	});
});
