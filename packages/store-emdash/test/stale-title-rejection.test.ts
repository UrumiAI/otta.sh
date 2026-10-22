/**
 * #540 item 9: a rejection describes why there is NO title. During a rollback,
 * older code that writes a valid title spreads the old document and so keeps a
 * leftover `titleRejection` beside it. That row must read as titled with no
 * rejection, never as both.
 */
import { describe, expect, test } from "vitest";
import {
	normalizeProductDoc,
	toProductCommerce,
	type ProductCommerceDoc,
} from "../src/product-commerce-documents.js";

const REASON = "The title is 612 characters long; the most it can be is 500.";

function productDoc(title: string | null, titleRejection: string | null): ProductCommerceDoc {
	return {
		productId: "p1",
		lifecycle: "live",
		sku: null,
		price: null,
		title,
		titleRejection,
		taxClass: null,
		taxStatus: "taxable",
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

describe("a titleRejection is reported only while the title is null", () => {
	test("a valid title with a leftover rejection reads with no rejection", () => {
		const doc = productDoc("Otta Mug", REASON);
		expect(toProductCommerce(doc)).toMatchObject({ title: "Otta Mug", titleRejection: null });
		expect(normalizeProductDoc(doc)).toMatchObject({ title: "Otta Mug", titleRejection: null });
	});

	test("a null title keeps its rejection", () => {
		const doc = productDoc(null, REASON);
		expect(toProductCommerce(doc).titleRejection).toBe(REASON);
		expect(normalizeProductDoc(doc).titleRejection).toBe(REASON);
	});
});
