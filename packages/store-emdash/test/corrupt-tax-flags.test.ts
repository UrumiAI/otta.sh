/**
 * PR 2b review B1/B2: a corrupted stored tax flag fails CLOSED. A product's
 * `taxStatus` that is not one of the known statuses reads `taxable`; a method's
 * `taxable` reads `false` only when it is exactly `false`.
 */
import { describe, expect, test } from "vitest";
import {
	normalizeProductDoc,
	toProductCommerce,
	type ProductCommerceDoc,
} from "../src/product-commerce-documents.js";
import {
	normalizeMethodDoc,
	toShippingMethod,
	type ShippingMethodDoc,
} from "../src/rules-documents.js";

const CORRUPT: unknown[] = ["NONE", "", 0, ["none"], null, "Taxable", "none "];

function productDoc(taxStatus: unknown): ProductCommerceDoc {
	return {
		productId: "p1",
		lifecycle: "live",
		sku: null,
		price: null,
		title: null,
		taxClass: null,
		taxStatus,
		compareAtPrice: null,
		unitCost: null,
		inventoryPolicy: "deny",
		weightGrams: null,
		lengthMm: null,
		widthMm: null,
		heightMm: null,
		productKind: "physical",
		downloadAsset: null,
		active: true,
		publishKey: "published",
		deletedAt: null,
		variants: {},
	} as unknown as ProductCommerceDoc;
}

describe("a corrupt stored product taxStatus reads as taxable (B1)", () => {
	for (const value of CORRUPT) {
		test(`${JSON.stringify(value)}`, () => {
			expect(normalizeProductDoc(productDoc(value)).taxStatus).toBe("taxable");
			expect(toProductCommerce(productDoc(value)).taxStatus).toBe("taxable");
		});
	}

	for (const value of ["taxable", "shipping_only", "none"] as const) {
		test(`a valid ${value} is kept`, () => {
			expect(normalizeProductDoc(productDoc(value)).taxStatus).toBe(value);
			expect(toProductCommerce(productDoc(value)).taxStatus).toBe(value);
		});
	}
});

function methodDoc(taxable: unknown): ShippingMethodDoc {
	return {
		methodId: "m1",
		name: "Flat",
		type: "flat_rate",
		taxable,
		rates: {},
	} as unknown as ShippingMethodDoc;
}

describe("a corrupt stored method taxable reads as taxed (B2)", () => {
	for (const value of [0, "", "false", null, undefined, true]) {
		test(`${JSON.stringify(value)}`, () => {
			expect(normalizeMethodDoc(methodDoc(value)).taxable).toBe(true);
			expect(toShippingMethod("z1", methodDoc(value)).taxable).toBe(true);
		});
	}

	test("only an explicit false turns tax off", () => {
		expect(normalizeMethodDoc(methodDoc(false)).taxable).toBe(false);
		expect(toShippingMethod("z1", methodDoc(false)).taxable).toBe(false);
	});
});
