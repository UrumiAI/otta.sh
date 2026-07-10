import { describe, expect, test } from "vitest";
import { cents, currency } from "../src/presentation/money.js";
import type { CatalogProductCommerce } from "../src/catalog/commerce-view.js";
import { joinProduct, type CmsProductContent } from "../src/catalog/join-product.js";
import { buildProductJsonLd } from "../src/catalog/product-json-ld.js";

const CONTENT: CmsProductContent = {
	id: "p1",
	title: "Bamboo Water Bottle",
	description: "A reusable bottle.",
	images: ["https://cdn.example.com/bottle.jpg"],
	url: "https://shop.example.com/products/bamboo-water-bottle",
};

function commerce(overrides: Partial<CatalogProductCommerce> = {}): CatalogProductCommerce {
	return {
		productId: "p1",
		sku: "SKU-1",
		price: { amount: cents(1999), currency: currency("USD") },
		inStock: true,
		active: true,
		...overrides,
	};
}

/**
 * Phase 2 §7 step 8 — schema.org Product/Offer JSON-LD (§1 case 3): the
 * Offer exists ONLY when purchasable; a non-purchasable product emits
 * Product with the `offers` key ABSENT — omission, never a null field.
 */
describe("buildProductJsonLd", () => {
	test("emits Product+Offer with price (major units, string), priceCurrency (ISO 4217), and availability when purchasable", () => {
		const jsonLd = buildProductJsonLd(joinProduct(CONTENT, commerce()));

		expect(jsonLd).toMatchObject({
			"@context": "https://schema.org",
			"@type": "Product",
			name: "Bamboo Water Bottle",
			description: "A reusable bottle.",
			image: ["https://cdn.example.com/bottle.jpg"],
			sku: "SKU-1",
			offers: {
				"@type": "Offer",
				price: "19.99",
				priceCurrency: "USD",
				availability: "https://schema.org/InStock",
			},
		});
		// Major units as a STRING — never a float that could re-round.
		const offers = jsonLd["offers"] as Record<string, unknown>;
		expect(typeof offers["price"]).toBe("string");
	});

	test("out-of-stock (coarse, display-only) maps to schema.org/OutOfStock — still an Offer, still purchasable data", () => {
		const jsonLd = buildProductJsonLd(joinProduct(CONTENT, commerce({ inStock: false })));
		const offers = jsonLd["offers"] as Record<string, unknown>;
		expect(offers["availability"]).toBe("https://schema.org/OutOfStock");
	});

	test("emits Product only — no Offer node, not an Offer with null price — when not purchasable", () => {
		const jsonLd = buildProductJsonLd(joinProduct(CONTENT, null));

		expect(jsonLd["@type"]).toBe("Product");
		expect(jsonLd["name"]).toBe("Bamboo Water Bottle");
		expect("offers" in jsonLd).toBe(false);
		expect("sku" in jsonLd).toBe(false);
		expect(JSON.stringify(jsonLd)).not.toContain("Offer");
	});

	test("a commerce-complete but INACTIVE product emits Product only — no Offer, no sku — exactly like the no-commerce case", () => {
		const jsonLd = buildProductJsonLd(joinProduct(CONTENT, commerce({ active: false })));

		expect(jsonLd["@type"]).toBe("Product");
		expect("offers" in jsonLd).toBe(false);
		expect("sku" in jsonLd).toBe(false);
		expect(JSON.stringify(jsonLd)).not.toContain("Offer");
	});

	test("zero-decimal currency price string carries no invented decimals", () => {
		const jsonLd = buildProductJsonLd(
			joinProduct(CONTENT, commerce({ price: { amount: cents(1999), currency: currency("JPY") } })),
		);
		const offers = jsonLd["offers"] as Record<string, unknown>;
		expect(offers["price"]).toBe("1999");
		expect(offers["priceCurrency"]).toBe("JPY");
	});

	test("content without optional fields emits a minimal Product node (no undefined-valued keys)", () => {
		const jsonLd = buildProductJsonLd(joinProduct({ id: "p2", title: "Bare Product" }, null));
		expect(jsonLd).toEqual({
			"@context": "https://schema.org",
			"@type": "Product",
			name: "Bare Product",
		});
	});

	test("stays additive: a later aggregateRating can be spread in without the builder fighting the key set (plan §8 risk 8)", () => {
		const base = buildProductJsonLd(joinProduct(CONTENT, commerce()));
		const extended: Record<string, unknown> = {
			...base,
			aggregateRating: { "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 12 },
		};
		expect(extended["offers"]).toEqual(base["offers"]);
		expect(extended["aggregateRating"]).toBeDefined();
	});
});
