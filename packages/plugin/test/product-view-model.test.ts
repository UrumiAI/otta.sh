/**
 * `buildProductViewModel`'s compare-at ("was") price. The admin stores one per
 * product; until this, no storefront read carried it.
 *
 * The store reports the was-price exactly as stored (`listCommerceByIds`), and
 * a stored one is allowed to sit at or below the price (a "was" during a price
 * rise is legitimate data). Whether it is a SALE is decided here, once, so no
 * theme re-derives it: the view model carries `compareAtPrice` only when it is
 * strictly above the price, in the same currency, on a product that is
 * actually for sale. Anything else is `null` — never a struck figure that
 * would claim a discount the store is not giving.
 */
import { describe, expect, test } from "vitest";
import type { CatalogProductCommerce } from "../src/catalog/commerce-view.js";
import { joinProduct, type CmsProductContent } from "../src/catalog/join-product.js";
import { cents, currency } from "../src/presentation/money.js";
import { buildProductViewModel } from "../src/storefront/product-view-model.js";

const CONTENT: CmsProductContent = { id: "p1", title: "Otta Tee", slug: "otta-tee" };
const LOCALE = "en-US";

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

const was = (amount: number, code = "USD") => ({
	amount: cents(amount),
	currency: currency(code),
});

describe("buildProductViewModel — the compare-at (was) price", () => {
	test("a was-price above the price is carried, formatted through the one money boundary", () => {
		const view = buildProductViewModel(
			joinProduct(CONTENT, commerce({ compareAtPrice: was(2000) })),
			LOCALE,
		);
		expect(view.compareAtPrice).toEqual({ amount: 2000, currency: "USD", formatted: "$20.00" });
		expect(view.price?.formatted).toBe("$12.00");
	});

	test("no was-price ⇒ null", () => {
		const view = buildProductViewModel(joinProduct(CONTENT, commerce()), LOCALE);
		expect(view.compareAtPrice).toBeNull();
	});

	test("a was-price EQUAL to the price is not a sale ⇒ null", () => {
		const view = buildProductViewModel(
			joinProduct(CONTENT, commerce({ compareAtPrice: was(1200) })),
			LOCALE,
		);
		expect(view.compareAtPrice).toBeNull();
	});

	test("a was-price BELOW the price (a price rise) is not a sale ⇒ null", () => {
		const view = buildProductViewModel(
			joinProduct(CONTENT, commerce({ compareAtPrice: was(900) })),
			LOCALE,
		);
		expect(view.compareAtPrice).toBeNull();
	});

	test("a was-price in another currency is not comparable ⇒ null (never compared across currencies)", () => {
		const view = buildProductViewModel(
			joinProduct(CONTENT, commerce({ compareAtPrice: was(2000, "EUR") })),
			LOCALE,
		);
		expect(view.compareAtPrice).toBeNull();
	});

	test("a product that is not for sale shows no was-price, exactly as it shows no price", () => {
		const view = buildProductViewModel(
			joinProduct(CONTENT, commerce({ active: false, compareAtPrice: was(2000) })),
			LOCALE,
		);
		expect(view.price).toBeNull();
		expect(view.compareAtPrice).toBeNull();
	});

	test("a sold-out product keeps its was-price — the price is still a fact, and so is the sale", () => {
		const view = buildProductViewModel(
			joinProduct(CONTENT, commerce({ inStock: false, compareAtPrice: was(2000) })),
			LOCALE,
		);
		expect(view.compareAtPrice?.formatted).toBe("$20.00");
	});
});
