/**
 * The store-level half of the checkout anti-N+1 guard, ported to the document
 * store: `getManyByProductId` must read a batch of N ids with ONE call, never fan
 * back out into a read per id.
 *
 * Unlike `listCommerceByIds` there is no stock to pair here — this is the RAW row
 * read — so the SQL invariant ports across intact and the assertion is exact: one
 * indexed `productId in [...]` query for the batch, zero per-id reads. Only the
 * unit changes, from a root SQL statement to a storage-port call.
 *
 * The batch is chunked at the host's `limit` ceiling of 100, so a batch LARGER
 * than that is `ceil(N / 100)` calls rather than one; the second case pins that
 * shape, because "one call" silently becoming "one call per row" at 101 ids would
 * be exactly the regression this file exists to catch.
 *
 * The behavioral cases live in `productCommerceStoreContract`. The caller-level
 * half — that the checkout paths call the bulk method once instead of looping
 * `getByProductId` — is pinned in the domain's own create-order test.
 */
import { cents, currency, idempotencyKey, money, productId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	EmdashProductCommerceStore,
	PRODUCT_COMMERCE_COLLECTION,
	type ProductCommerceDoc,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { countingCollection, withCollection } from "./helpers/fault-injection.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

/** Seed `count` priced products and return their ids. */
async function seedProducts(
	h: ReturnType<typeof makeProductCommerceHarness>,
	prefix: string,
	count: number,
) {
	const ids = [];
	for (let i = 0; i < count; i++) {
		const pid = productId(`${prefix}-${String(i)}`);
		ids.push(pid);
		await h.store.upsert(
			{
				productId: pid,
				sku: sku(`SKU-${prefix.toUpperCase()}-${String(i)}`),
				price: money(cents(100 + i), currency("USD")),
				title: `Title ${String(i)}`,
			},
			idempotencyKey(`k-${prefix}-${String(i)}`),
		);
	}
	return ids;
}

describeEachDialect("getManyByProductId call count", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	/** A store whose product collection counts what it was asked. */
	function countedStore(h: ReturnType<typeof makeProductCommerceHarness>) {
		const products = countingCollection<ProductCommerceDoc>(
			bound.collection<ProductCommerceDoc>(PRODUCT_COMMERCE_COLLECTION),
		);
		return {
			counts: products.counts,
			store: new EmdashProductCommerceStore({
				storage: withCollection(bound.storage, PRODUCT_COMMERCE_COLLECTION, products.collection),
				clock: h.clock,
			}),
		};
	}

	test("one query for a batch of ten ids, and never a read per id", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const ids = await seedProducts(h, "prod-snap", 10);
		const counted = countedStore(h);

		const map = await counted.store.getManyByProductId([...ids, ...ids.slice(0, 3)]);

		expect(map.size).toBe(10);
		expect(counted.counts.of("query")).toBe(1);
		expect(counted.counts.of("get")).toBe(0);
	});

	test("a batch past the host's limit ceiling pages — one call per 100 ids, not one per id", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const ids = await seedProducts(h, "prod-page", 120);
		const counted = countedStore(h);

		const map = await counted.store.getManyByProductId(ids);

		expect(map.size).toBe(120);
		// Two chunks of ids; the first fills its page exactly, so the host reports
		// more and that chunk costs a second, empty read. Three calls for 120 ids,
		// which is the ceiling's arithmetic — and nothing like 120.
		expect(counted.counts.of("query")).toBeLessThanOrEqual(4);
		expect(counted.counts.of("get")).toBe(0);
	});

	test("an empty id batch issues no storage calls at all", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const counted = countedStore(h);

		expect((await counted.store.getManyByProductId([])).size).toBe(0);
		expect(counted.counts.of("query")).toBe(0);
		expect(counted.counts.of("get")).toBe(0);
	});
});
