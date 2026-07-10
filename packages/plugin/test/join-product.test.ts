import { describe, expect, test } from "vitest";
import { cents, currency } from "../src/presentation/money.js";
import type { CatalogProductCommerce } from "../src/catalog/commerce-view.js";
import { joinProduct, type CmsProductContent } from "../src/catalog/join-product.js";

const CONTENT: CmsProductContent = {
	id: "p1",
	title: "Bamboo Water Bottle",
	slug: "bamboo-water-bottle",
	description: "A reusable bottle.",
	images: ["https://cdn.example.com/bottle.jpg"],
};

const COMMERCE: CatalogProductCommerce = {
	productId: "p1",
	sku: "SKU-1",
	price: { amount: cents(1999), currency: currency("USD") },
	inStock: true,
};

/**
 * Phase 2 §7 step 6 — the pure content+commerce join (§4.2): CMS content and
 * commerce-service data meet HERE, in app code, joined by
 * `productId = CMS id` — never in SQL across the two databases. `purchasable`
 * is the ONE computed truth every downstream consumer (price slot, JSON-LD,
 * Phase 3's add-to-cart gate) reads instead of re-deriving it.
 */
describe("joinProduct", () => {
	test("returns purchasable:true with the commerce view attached when a commerce record exists", () => {
		const joined = joinProduct(CONTENT, COMMERCE);

		expect(joined.purchasable).toBe(true);
		expect(joined.content).toBe(CONTENT);
		expect(joined.commerce).toBe(COMMERCE);
		expect(joined.commerce?.price.amount).toBe(1999);
		expect(joined.commerce?.inStock).toBe(true);
	});

	test("returns purchasable:false and commerce:null when no commerce record exists", () => {
		// Covers all three absences identically (§4.2): never synced ("create,
		// then price" unfinished), soft-deleted, or simply omitted by the batch.
		const joined = joinProduct(CONTENT, null);

		expect(joined.purchasable).toBe(false);
		expect(joined.commerce).toBeNull();
		// The content still renders — hidden from purchase, not from the catalog.
		expect(joined.content.title).toBe("Bamboo Water Bottle");
	});
});
