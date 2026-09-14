/**
 * The anti-N+1 guard for `listCommerceByIds`, ported to the document store.
 *
 * **What the SQL pinned, and what can survive.** The Kysely suite counted ROOT
 * STATEMENTS and asserted exactly ONE for a batch of N ids, `inStock` included —
 * the intra-service `product_commerce ⋈ inventory` join must never split into a
 * commerce query plus a separate inventory query. Half of that is a statement
 * about joins, and a document store has none: the stock a view needs lives in a
 * different document and there is no primitive that reads two collections at once.
 * So the invariant is ported in the two halves it actually decomposes into, and
 * both are real regression guards:
 *
 *  1. **The product half stays ONE call for the whole batch** — a
 *     `productId in [...]` query, not a `get` per id. A refactor back to per-id
 *     reads fails this.
 *  2. **The stock half is at most one read per DISTINCT sku, issued
 *     concurrently** — never one per input id, never twice for a sku appearing
 *     twice, and never a sequential walk. The memoized reader is what makes that
 *     true, and `peakConcurrency` is what proves the reads overlap rather than
 *     queueing, which is the part a plain count cannot see.
 *
 * What is NOT claimed is that this equals one round trip. It does not, and the
 * store cannot make it so; the port's own wording ("never an N+1 of per-row
 * `getOnHand` reads") is about the CALLER never paying a round trip per row, and
 * that still holds — the caller makes one call.
 *
 * The behavioral cases live in `productCommerceStoreContract`; this file pins only
 * the call-shape invariant, which the contract suite cannot see.
 */
import { cents, currency, idempotencyKey, money, productId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	type InventoryDoc,
	type ProductCommerceDoc,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { countingCollection, withCollection } from "./helpers/fault-injection.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

const BATCH = 25;

describeEachDialect("listCommerceByIds call count", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	test("one query for the whole batch, and at most one stock read per distinct sku", async () => {
		// Seeded through an UNcounted harness, so setup writes never pollute the tally.
		const h = makeProductCommerceHarness(bound.storage);
		const ids = [];
		for (let i = 0; i < BATCH; i++) {
			const pid = productId(`prod-count-${String(i)}`);
			ids.push(pid);
			await h.store.upsert(
				{
					productId: pid,
					sku: sku(`SKU-COUNT-${String(i)}`),
					price: money(cents(100 + i), currency("USD")),
				},
				idempotencyKey(`k-count-${String(i)}`),
			);
		}
		// Half the skus get an inventory document, half none — so the batch
		// demonstrably carried BOTH outcomes of the stock pairing.
		for (let i = 0; i < BATCH; i += 2) await h.seedStock(`SKU-COUNT-${String(i)}`, 3);

		const products = countingCollection<ProductCommerceDoc>(
			bound.collection<ProductCommerceDoc>(PRODUCT_COMMERCE_COLLECTION),
		);
		const inventory = countingCollection<InventoryDoc>(
			bound.collection<InventoryDoc>(INVENTORY_COLLECTION),
		);
		const counted = new EmdashProductCommerceStore({
			storage: withCollection(
				withCollection(bound.storage, PRODUCT_COMMERCE_COLLECTION, products.collection),
				INVENTORY_COLLECTION,
				inventory.collection,
			),
			clock: h.clock,
		});

		// Duplicated ids on the way in: the batch must still be one query, and a sku
		// must still be read once.
		const views = await counted.listCommerceByIds([...ids, ...ids.slice(0, 5)]);

		expect(views).toHaveLength(BATCH);
		expect(views.filter((v) => v.inStock)).toHaveLength(13);
		expect(views.filter((v) => !v.inStock)).toHaveLength(12);

		// (1) The product half: ONE indexed query for 25 ids, and never a per-id read.
		expect(products.counts.of("query")).toBe(1);
		expect(products.counts.of("get")).toBe(0);
		// (2) The stock half: one read per DISTINCT sku, no more — the memo is what
		//     keeps the five duplicated ids from doubling it.
		expect(inventory.counts.of("get")).toBe(BATCH);
		expect(new Set(inventory.counts.idsFor("get")).size).toBe(BATCH);
		// …and they overlap, rather than queueing one latency after another.
		expect(inventory.counts.peakConcurrency()).toBeGreaterThan(1);
	});

	test("an empty id batch issues no storage calls at all", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const products = countingCollection<ProductCommerceDoc>(
			bound.collection<ProductCommerceDoc>(PRODUCT_COMMERCE_COLLECTION),
		);
		const inventory = countingCollection<InventoryDoc>(
			bound.collection<InventoryDoc>(INVENTORY_COLLECTION),
		);
		const counted = new EmdashProductCommerceStore({
			storage: withCollection(
				withCollection(bound.storage, PRODUCT_COMMERCE_COLLECTION, products.collection),
				INVENTORY_COLLECTION,
				inventory.collection,
			),
			clock: h.clock,
		});

		expect(await counted.listCommerceByIds([])).toEqual([]);
		expect(products.counts.of("query")).toBe(0);
		expect(products.counts.of("get")).toBe(0);
		expect(inventory.counts.of("get")).toBe(0);
	});
});
