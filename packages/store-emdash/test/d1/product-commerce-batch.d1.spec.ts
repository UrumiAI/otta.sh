/**
 * The product batch reads at their full width, on **D1** (issue #578).
 *
 * D1 binds at most 100 parameters per statement, and the host's `query` binds
 * `plugin_id`, `collection` and the `limit` on top of every `in` value (plus two
 * more on a cursor page). A batch of 98 or more ids in ONE `productId in [...]`
 * statement is therefore over the bound, and only D1 says so — SQLite and Postgres
 * allow far more, which is why the Node tiers cannot catch it. The callers really
 * do send 100: the storefront loader's batch ceiling and the admin Products
 * summaries are both 100 ids.
 *
 * The three methods that share `#readBatch` are each driven at 100, so a fix that
 * chunks one path and not another fails here.
 */
import { productId, sku } from "@urumi.ai/otta-domain";
import { describe, expect, test } from "vitest";
import { PRODUCT_COMMERCE_LAYOUT } from "../product-commerce-collections.js";
import { makeProductCommerceHarness } from "../product-commerce-harness.js";
import { useD1Storage } from "./describe-d1.js";

/** The widest batch a caller sends: `DEFAULT_MAX_BATCH_SIZE` and `MAX_SUMMARY_IDS`. */
const WIDTH = 100;

const bound = useD1Storage(PRODUCT_COMMERCE_LAYOUT);

async function seedWide() {
	const h = makeProductCommerceHarness(bound.storage);
	const ids = [];
	const skus = [];
	for (let i = 0; i < WIDTH; i++) {
		const id = `prod-wide-${String(i).padStart(3, "0")}`;
		const s = `SKU-WIDE-${String(i).padStart(3, "0")}`;
		await h.seedProduct({
			id,
			sku: s,
			priceCents: 100 + i,
			title: `Wide ${String(i)}`,
			active: true,
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		ids.push(productId(id));
		skus.push(sku(s));
	}
	return { h, ids, skus };
}

describe("product batch reads at 100 ids on D1 (#578)", () => {
	test("listCommerceByIds answers every one of 100 ids", async () => {
		const { h, ids } = await seedWide();
		const views = await h.store.listCommerceByIds(ids);
		expect(new Set(views.map((v) => v.productId))).toEqual(new Set(ids));
	});

	test("getManyByProductId answers every one of 100 ids", async () => {
		const { h, ids } = await seedWide();
		const rows = await h.store.getManyByProductId(ids);
		expect(new Set(rows.keys())).toEqual(new Set(ids));
	});

	test("getProductIdsBySku answers every one of 100 skus", async () => {
		const { h, ids, skus } = await seedWide();
		const owners = await h.store.getProductIdsBySku(skus);
		expect(owners.size).toBe(WIDTH);
		skus.forEach((s, i) => expect(owners.get(s)).toBe(ids[i]));
	});
});
