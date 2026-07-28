/**
 * Nav helpers (src/lib/nav.ts). These are the two places the site chrome makes
 * a judgement rather than rendering a value, and both fail SILENTLY when they
 * are wrong: the badge simply does not appear, or a screen reader reads
 * punctuation. Real unit tests, not source-text pins.
 */
import { describe, expect, test } from "vitest";
import { cartCountLabel, isCartLink } from "../src/lib/nav.js";

describe("isCartLink", () => {
	test.each(["/cart", "/cart/", "/cart//", "/cart?added=1", "/cart#lines", "/cart/?added=1"])(
		"recognises %s — menu URLs are CMS-authored, so all of these are legal to type",
		(url) => {
			expect(isCartLink(url)).toBe(true);
		},
	);

	test.each(["/", "/carts", "/cart-rules", "/products", "/checkout", ""])(
		"does not claim %s",
		(url) => {
			expect(isCartLink(url)).toBe(false);
		},
	);
});

describe("cartCountLabel", () => {
	test("says 'item' for one and 'items' for anything else", () => {
		expect(cartCountLabel(1)).toBe("1 item");
		expect(cartCountLabel(0)).toBe("0 items");
		expect(cartCountLabel(3)).toBe("3 items");
	});
});
