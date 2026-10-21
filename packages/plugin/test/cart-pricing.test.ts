import { describe, expect, test } from "vitest";
import type { CatalogProductCommerce } from "../src/catalog/commerce-view.js";
import { cents, currency } from "../src/presentation/money.js";
import type { CartLineWire } from "../src/product-commerce/commerce-client.js";
import { buildCartPricing } from "../src/storefront/cart-pricing.js";

const LINE: CartLineWire = {
	lineId: "l1",
	sku: "OTTA-TEE",
	productId: "p1",
	qty: 2,
	reservationId: "r1",
	expiresAt: null,
};

function commerce(overrides: Partial<CatalogProductCommerce> = {}): CatalogProductCommerce {
	return {
		productId: "p1",
		sku: "OTTA-TEE",
		price: { amount: cents(1200), currency: currency("USD") },
		title: "Otta Tee",
		compareAtPrice: null,
		inStock: true,
		active: true,
		...overrides,
	};
}

/**
 * The cart prices a line only when checkout would sell it — the same
 * sellability rule (#109). Otherwise the cart showed a complete total and
 * checkout then refused the line.
 */
describe("buildCartPricing — a line is priced only when it is sellable", () => {
	test("a sellable line is priced, and the cart says every line is", () => {
		const pricing = buildCartPricing([LINE], new Map([["p1", commerce()]]), "USD", "en-US");
		expect(pricing.lines[0]?.unitPrice?.amount).toBe(1200);
		expect(pricing.lines[0]?.lineTotal?.amount).toBe(2400);
		expect(pricing.allLinesPriced).toBe(true);
	});

	test("a line whose product has NO TITLE is unpriced, and the total is caveated", () => {
		const pricing = buildCartPricing(
			[LINE],
			new Map([["p1", commerce({ title: null })]]),
			"USD",
			"en-US",
		);
		expect(pricing.lines[0]?.unitPrice).toBeNull();
		expect(pricing.lines[0]?.lineTotal).toBeNull();
		expect(pricing.allLinesPriced).toBe(false);
		expect(pricing.total).toBeNull();
	});

	test("an unpublished line is unpriced, as before", () => {
		const pricing = buildCartPricing(
			[LINE],
			new Map([["p1", commerce({ active: false })]]),
			"USD",
			"en-US",
		);
		expect(pricing.lines[0]?.unitPrice).toBeNull();
		expect(pricing.allLinesPriced).toBe(false);
	});
});
