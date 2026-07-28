/**
 * The three catalog pages, after increment 3 of the theme rollout
 * (docs/theme/TEMPERED.md §7, §8, §10, §11).
 *
 * There is no render harness for PAGES in this package — a page reads the CMS
 * and dispatches a plugin route in its frontmatter, neither of which the
 * Container API can stand up (issue #40) — so these are source assertions, the
 * same pattern `footer-currency.test.ts` and `json-ld-xss.test.ts` use. That is
 * enough for the three things worth breaking a build over here:
 *
 *  1. §7 — no page assembles a money string. Prices arrive pre-formatted.
 *  2. §8 — the home hero omits the tape entirely when commerce is unreachable,
 *     rather than rendering an error box on a page nobody asked a price of.
 *  3. The PDP's add-to-cart form still carries the plugin's idempotency key and
 *     the ids the /cart/add endpoint needs. The theme restyled that form; it
 *     must not have quietly changed what it posts.
 *
 * Rendered behaviour (layout, focus rings, the dark palette) is verified in a
 * workerd preview with screenshots, and is not what this file is for.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages");
const read = (relative: string): string => readFileSync(path.join(PAGES, relative), "utf8");

const HOME = read("index.astro");
const PLP = read("products/index.astro");
const PDP = read("products/[slug].astro");

/** The pages increment 3 moved onto the token layer. Increments 4–6 add theirs. */
const MIGRATED: ReadonlyArray<readonly [string, string]> = [
	["index.astro", HOME],
	["products/index.astro", PLP],
	["products/[slug].astro", PDP],
];

/** A page's `<style>` blocks, comments stripped — prose about a colour is not
 *  a colour. Mirrors `component-css.test.ts`, which sweeps components only. */
function declarations(text: string): string {
	return [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)]
		.map((match) => match[1] ?? "")
		.join("\n")
		.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("§2/§3 — the pages read the token layer and write no vocabulary of their own", () => {
	test.each(MIGRATED)("%s declares no raw colour", (_file, source) => {
		const css = declarations(source);
		expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
	});

	test.each(MIGRATED)("%s names no font family of its own", (_file, source) => {
		// `font-family: var(--u-display)` is the only legal form.
		const families = [...declarations(source).matchAll(/font-family:([^;]*);/g)].map(
			([, value = ""]) => value,
		);
		expect(families.length).toBeGreaterThan(0);
		for (const value of families) {
			expect(value).toMatch(/var\(--u-(display|body|data)\)/);
		}
	});

	test.each(MIGRATED)("%s uses the theme's one radius", (_file, source) => {
		const radii = [...declarations(source).matchAll(/border-radius:([^;]*);/g)].map(
			([, value = ""]) => value,
		);
		for (const value of radii) {
			expect(value).toContain("var(--u-r)");
		}
	});

	test.each(MIGRATED)("%s does not restyle the global focus ring", (_file, source) => {
		// §11's ring is one rule in tokens.css. A page that writes its own is how
		// a store ends up with two.
		expect(declarations(source)).not.toMatch(/:focus(-visible)?\s*\{/);
	});

	test.each(MIGRATED)("%s carries no legacy `.notice` panel", (_file, source) => {
		// The pale panel `legacy-bridge.css` pins ink to. The theme's degraded
		// surface is the Notice component (§4), which has no filled background.
		expect(source).not.toMatch(/class="notice"/);
	});
});

describe("§7 — no page assembles money", () => {
	test.each(MIGRATED)("%s renders only pre-formatted figures", (_file, source) => {
		// A currency symbol in page source means someone built a price out of an
		// amount. `price.formatted` (and `.label`) are the only legal sources.
		// (`$` is exempted only where it opens a template placeholder.)
		expect(source).not.toMatch(/\$(?!\{)/);
		expect(source).not.toMatch(/[€£¥]/);
		expect(source).not.toMatch(/toFixed\(|Intl\.NumberFormat/);
	});

	test("the home tape and the catalog cards both print `price.formatted`", () => {
		expect(HOME).toContain("product.price.formatted");
		expect(PLP).toContain("product.price.formatted");
	});

	test("the PDP hands PriceTag the formatted string, not an amount", () => {
		expect(PDP).toMatch(/<PriceTag[\s\S]{0,200}formatted=\{product\.price\.formatted\}/);
		expect(PDP).not.toMatch(/<PriceTag[\s\S]{0,200}amount=/);
	});
});

describe("§8 — the home hero and its degraded rule", () => {
	test("the tape renders only when there is at least one priced row", () => {
		// The whole degraded contract in one line: no rows ⇒ no tape. The page
		// used to make no commerce call at all, and it must still render a
		// complete hero when the commerce service is unreachable.
		expect(HOME).toMatch(/rows\.length > 0 &&/);
	});

	test("a degraded home shows NO error box — that is the catalog page's job", () => {
		expect(HOME).not.toContain("Notice");
	});

	test("the tape's stock cell states the availability token, never a count", () => {
		// The product view model carries `availability` (in_stock/out_of_stock)
		// and NO numeric stock. The mockup's "12 in stock" is not derivable, so
		// the tape says what it knows.
		expect(HOME).toContain('product.availability === "in_stock" ? "In stock" : "Sold out"');
		expect(HOME).not.toMatch(/\bonHand\b|\bstockCount\b|\bavailable\s*\+/);
	});

	test("the hero reads the same catalog the shop page reads", () => {
		expect(HOME).toContain("STOREFRONT_LIST_ROUTE");
		expect(HOME).toContain("dispatchUrumiRoute");
	});

	test("the tape is bounded, so a large catalog cannot push the shop link away", () => {
		expect(HOME).toMatch(/TAPE_ROWS\s*=\s*\d+/);
		expect(HOME).toContain("slice(0, TAPE_ROWS)");
	});
});

describe("the catalog grid", () => {
	test("cards get their grid position, so the coil tints cycle (§5)", () => {
		expect(PLP).toMatch(/<ProductCard[\s\S]{0,200}index=\{index\}/);
	});

	test("a card with no live price gets `null`, not a figure and not a zero", () => {
		expect(PLP).toMatch(/price=\{[\s\S]{0,160}: null\s*\}/);
	});

	test("the degraded catalog still renders every product, content-only", () => {
		expect(PLP).toContain("purchasable: false");
		expect(PLP).toContain("<Notice");
	});

	test("the empty catalog is a designed state with a next move", () => {
		expect(PLP).toContain("No products yet.");
		expect(PLP).toContain("/_emdash/admin");
	});
});

describe("the PDP's add-to-cart form is unchanged in behaviour", () => {
	test("it still posts the four fields /cart/add reads", () => {
		expect(PDP).toMatch(/method="POST"\s+action="\/cart\/add"/);
		for (const field of ["sku", "productId", "idempotencyKey", "returnTo"]) {
			expect(PDP, `${field} is no longer posted`).toMatch(
				new RegExp(`name="${field}"\\s+value=\\{`),
			);
		}
	});

	test("the quantity field still posts `qty`, minimum one", () => {
		expect(PDP).toMatch(/<QtyField[^>]*name="qty"/);
		expect(PDP).toMatch(/<QtyField[^>]*min=\{1\}/);
	});

	test("the idempotency key is the plugin's, never minted here", () => {
		// Freshly minted per rendered PDP by the plugin: a double-submit of ONE
		// rendered form replays, a reload does not.
		expect(PDP).toContain("addToCart.idempotencyKey");
		expect(PDP).not.toMatch(/randomUUID|crypto\./);
	});

	test("the form only exists for a product that is actually in stock", () => {
		expect(PDP).toMatch(/addToCart && inStock &&/);
	});

	test("the hold note states the service's real TTL", () => {
		// @urumi/domain's DEFAULT_HOLD_TTL_MS is 15 minutes, and the mockup's
		// "10 minutes" was a draft figure. §10 keeps the hold visible to the
		// shopper — it is useful — so the number has to be the true one.
		//
		// KNOWN DISAGREEMENT, reported with this increment: src/lib/hold.ts
		// pins `HOLD_WINDOW_SECONDS = 600` for the cart's hold ribbon, which
		// assumes ten. That file belongs to the cart increment; when it is
		// corrected to 900 this copy and that constant agree again.
		expect(PDP).toContain("holds one in stock for 15 minutes");
	});
});

describe("§10 — shopper-side copy", () => {
	test.each(MIGRATED)("%s never markets the inventory guarantee", (_file, source) => {
		expect(source.toLowerCase()).not.toContain("oversell");
		expect(source.toLowerCase()).not.toContain("atomic");
	});

	test.each(MIGRATED)("%s names no internals to the shopper", (_file, source) => {
		// Prose only: the frontmatter legitimately talks about the commerce
		// service and view models, and the comments explain them.
		const body = source.slice(source.indexOf("\n---", 3) + 4).replace(/<style>[\s\S]*$/, "");
		const prose = body.replace(/\{\s*\/\*[\s\S]*?\*\/\s*/g, "");
		expect(prose).not.toMatch(/commerce service|view model|\bCMS\b/i);
	});
});
