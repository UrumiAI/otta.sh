/**
 * The products collection's `pricing` field is a placeholder for the editor's
 * Pricing & stock cards and must never feed the storefront (ADR-0014, amendment
 * 2026-10-01). Even if a value were ever stored in it — say, typed into EmDash's
 * raw JSON fallback editor — the storefront builds a product from an explicit
 * list of content fields, so the value goes nowhere.
 */
import { expect, test } from "vitest";
import { toCmsProductContent, type ProductEntryData } from "../src/lib/products.js";

test("a value in the `pricing` field never reaches the storefront's product", () => {
	const entry = {
		id: "01PROD",
		slug: "otta-tee",
		title: "Otta Tee",
		description: "Soft.",
		images: undefined,
		pricing: { price: 1, stock: 999 },
	} as unknown as ProductEntryData;
	const product = toCmsProductContent(entry);
	expect(product).not.toHaveProperty("pricing");
	expect(JSON.stringify(product)).not.toContain("999");
});
