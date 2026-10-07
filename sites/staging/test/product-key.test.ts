/**
 * ONE product key (`lib/products.ts`): the catalog card's `slug`, the product
 * page's `art`, a bag line's `artKey` and every product path agree on it, so a
 * theme that ties them together (a card → product → bag morph naming all three
 * alike) cannot break silently the day one of them drifts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { productKey, productPath } from "../src/lib/products.js";
import { SRC } from "./theme-views.js";

const page = (file: string): string => readFileSync(path.join(SRC, "pages", file), "utf8");

describe("one product key, so the card, the product page and the bag line agree", () => {
	test("productKey is the slug, else the id; productPath is built from it", () => {
		expect(productKey({ slug: "vase", id: "p-1" })).toBe("vase");
		expect(productKey({ slug: null, id: "p-1" })).toBe("p-1");
		expect(productKey({ id: "p-1" })).toBe("p-1");
		expect(productPath("vase", "p-1")).toBe(`/products/${productKey({ slug: "vase", id: "p-1" })}`);
		expect(productPath(null, "p-1")).toBe("/products/p-1");
	});

	test("the cart line, the product page and both card mappings all key off productKey", () => {
		const cartPage = page("cart/index.astro");
		// The line's art key and its link come from the same product.
		expect(cartPage).toMatch(
			/artKey: content === null \? \(line\.productId \?\? line\.sku\) : productKey\(content\)/,
		);
		expect(cartPage).toContain(
			"href: content === null ? null : productPath(content.slug, content.id)",
		);
		expect(page("products/[slug].astro")).toContain(
			'const art = content !== null ? productKey(content) : "";',
		);
		for (const file of ["index.astro", "products/index.astro"]) {
			expect(page(file), file).toContain("slug: productKey(product),");
		}
		expect(readFileSync(path.join(SRC, "lib/bag.ts"), "utf8")).toMatch(
			/artKey: content === null \? \(line\.productId \?\? line\.sku\) : productKey\(content\)/,
		);
	});
});
