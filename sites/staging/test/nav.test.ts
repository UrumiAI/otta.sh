/**
 * Nav helpers (src/lib/nav.ts). These are the two places the site chrome makes
 * a judgement rather than rendering a value, and both fail SILENTLY when they
 * are wrong: the badge simply does not appear, or a screen reader reads
 * punctuation. Real unit tests, not source-text pins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { cartCountLabel, FALLBACK_MENU_ITEMS, isCartLink } from "../src/lib/nav.js";

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

/**
 * The nav the layout substitutes when the content store cannot be reached
 * (`Base.astro`, guarded in increment 6). Its whole justification is that these
 * links resolve when nothing else does — so the thing worth testing is that
 * every one of them is a route THIS SITE defines, not a guess at the operator's
 * menu.
 */
describe("FALLBACK_MENU_ITEMS", () => {
	const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages");

	test.each([
		["/", "index.astro"],
		["/products", "products/index.astro"],
		["/cart", "cart/index.astro"],
	])("%s is a real page in this theme (%s)", (url, file) => {
		expect(FALLBACK_MENU_ITEMS.map((item) => item.url)).toContain(url);
		// Read, not `existsSync`: a route that is an empty file would satisfy the
		// weaker check and render nothing.
		expect(readFileSync(path.join(PAGES, file), "utf8").length).toBeGreaterThan(0);
	});

	test("it carries the cart, so the badge still has somewhere to live", () => {
		expect(FALLBACK_MENU_ITEMS.some((item) => isCartLink(item.url))).toBe(true);
	});

	test("every entry has a label a shopper can read", () => {
		for (const item of FALLBACK_MENU_ITEMS) {
			expect(item.label.trim().length).toBeGreaterThan(0);
		}
	});

	test("the labels match the seeded menu, so the chrome does not reword mid-outage", () => {
		const seed = JSON.parse(readFileSync(path.resolve(PAGES, "../../seed/seed.json"), "utf8")) as {
			menus: { name: string; items: { label: string; url: string }[] }[];
		};
		const primary = seed.menus.find((menu) => menu.name === "primary");
		expect(primary).toBeDefined();
		for (const item of FALLBACK_MENU_ITEMS) {
			expect(
				primary?.items.find((seeded) => seeded.url === item.url)?.label,
				`the seeded menu labels ${item.url} differently`,
			).toBe(item.label);
		}
	});
});
