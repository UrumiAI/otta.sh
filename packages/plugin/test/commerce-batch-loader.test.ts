import { describe, expect, test } from "vitest";
import { cents, currency } from "../src/presentation/money.js";
import { CommerceBatchLoader } from "../src/catalog/commerce-batch-loader.js";
import type { CatalogProductCommerce } from "../src/catalog/commerce-view.js";

function view(productId: string): CatalogProductCommerce {
	return {
		productId,
		sku: `SKU-${productId}`,
		price: { amount: cents(1999), currency: currency("USD") },
		inStock: true,
		active: true,
	};
}

interface FakeBatchSource {
	calls: string[][];
	fetchBatch(ids: string[]): Promise<CatalogProductCommerce[]>;
}

function makeSource(known: string[]): FakeBatchSource {
	const knownSet = new Set(known);
	const source: FakeBatchSource = {
		calls: [],
		async fetchBatch(ids) {
			source.calls.push([...ids]);
			return ids.filter((id) => knownSet.has(id)).map(view);
		},
	};
	return source;
}

/**
 * Phase 2 §7 step 5 — the request-scoped micro-batching loader (§4.3.2):
 * regardless of whether the outer wiring looks up products one-by-one or
 * page-at-a-time, lookups issued within one render pass coalesce into one
 * batched call, and nothing is fetched twice within the pass. One loader
 * instance per render; there is deliberately NO cross-request cache (plan
 * §8 risk 3, pre-approved: intra-render dedupe only in v1).
 */
describe("CommerceBatchLoader", () => {
	test("N individual load calls issued within one render pass coalesce into exactly one batch call", async () => {
		const source = makeSource(["p1", "p2", "p3"]);
		const loader = new CommerceBatchLoader((ids) => source.fetchBatch(ids));

		const [a, b, c] = await Promise.all([loader.load("p1"), loader.load("p2"), loader.load("p3")]);

		expect(source.calls).toEqual([["p1", "p2", "p3"]]);
		expect(a?.productId).toBe("p1");
		expect(b?.productId).toBe("p2");
		expect(c?.productId).toBe("p3");
	});

	test("a lookup for an id already resolved from a prior batch in this render is not re-fetched", async () => {
		const source = makeSource(["p1", "p2"]);
		const loader = new CommerceBatchLoader((ids) => source.fetchBatch(ids));

		await Promise.all([loader.load("p1"), loader.load("p2")]);
		const again = await loader.load("p1");

		expect(source.calls).toEqual([["p1", "p2"]]);
		expect(again?.productId).toBe("p1");
	});

	test("an id the batch omitted resolves to null (absence, not an error) and is not re-fetched either", async () => {
		const source = makeSource(["p1"]);
		const loader = new CommerceBatchLoader((ids) => source.fetchBatch(ids));

		const [hit, miss] = await Promise.all([loader.load("p1"), loader.load("p-missing")]);
		expect(hit).not.toBeNull();
		expect(miss).toBeNull();

		// The recorded absence is cached for the rest of the render pass.
		expect(await loader.load("p-missing")).toBeNull();
		expect(source.calls).toHaveLength(1);
	});

	test("loadMany dedupes duplicate ids within the page and issues one batch call", async () => {
		const source = makeSource(["p1", "p2"]);
		const loader = new CommerceBatchLoader((ids) => source.fetchBatch(ids));

		const result = await loader.loadMany(["p1", "p2", "p1", "p-missing"]);

		expect(source.calls).toEqual([["p1", "p2", "p-missing"]]);
		expect(result.get("p1")?.productId).toBe("p1");
		expect(result.get("p2")?.productId).toBe("p2");
		expect(result.get("p-missing")).toBeNull();
	});

	test("a pathological over-cap tick splits into capped chunks so the request body stays bounded", async () => {
		const ids = Array.from({ length: 7 }, (_, i) => `p${i}`);
		const source = makeSource(ids);
		const loader = new CommerceBatchLoader((batch) => source.fetchBatch(batch), {
			maxBatchSize: 3,
		});

		await loader.loadMany(ids);

		expect(source.calls.map((c) => c.length)).toEqual([3, 3, 1]);
	});

	test("a failed batch rejects that pass's lookups and evicts them so a later retry can refetch", async () => {
		let failNext = true;
		const source = makeSource(["p1"]);
		const loader = new CommerceBatchLoader(async (ids) => {
			if (failNext) {
				failNext = false;
				throw new Error("service unavailable");
			}
			return source.fetchBatch(ids);
		});

		await expect(loader.load("p1")).rejects.toThrow("service unavailable");
		// The failure was not cached as a permanent answer.
		expect((await loader.load("p1"))?.productId).toBe("p1");
	});
});
