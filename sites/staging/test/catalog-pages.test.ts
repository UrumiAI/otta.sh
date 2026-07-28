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
 * What is NOT here: the tape's rows, the catalog counts and the headline
 * fallbacks. Those moved to `src/lib/tape.ts` and are covered BEHAVIOURALLY in
 * `tape.test.ts` — a grep for `slice(0, TAPE_ROWS)` proved a line existed, not
 * that a seventh product was dropped.
 *
 * Rendered behaviour (layout, focus rings, the dark palette) is verified in a
 * workerd preview with screenshots, and is not what this file is for.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.resolve(HERE, "../src/pages");
const read = (relative: string): string => readFileSync(path.join(PAGES, relative), "utf8");

const HOME = read("index.astro");
const PLP = read("products/index.astro");
const PDP = read("products/[slug].astro");
const TAPE = readFileSync(path.resolve(HERE, "../src/lib/tape.ts"), "utf8");
const SEED = readFileSync(path.resolve(HERE, "../seed/seed.json"), "utf8");

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

	test("the catalog cards and the tape builder both print `price.formatted`", () => {
		expect(PLP).toContain("product.price.formatted");
		// The home page's rows are built in src/lib/tape.ts, which is held to the
		// same rule — it is the only other place in the theme that reads a price
		// off a view model and puts it in a cell.
		expect(TAPE).toContain("product.price.formatted");
		expect(TAPE).not.toMatch(/toFixed\(|Intl\.NumberFormat/);
		// Same exemption the page sweep uses: `$` only ever opens a template
		// placeholder here (the item COUNTS), never a currency symbol.
		expect(TAPE).not.toMatch(/\$(?!\{)/);
		expect(TAPE).not.toMatch(/[€£¥]/);
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

	test("the hero reads the same catalog the shop page reads", () => {
		expect(HOME).toContain("STOREFRONT_LIST_ROUTE");
		expect(HOME).toContain("dispatchUrumiRoute");
	});

	test("a content-store failure lands in the SAME degraded branch, not a 500", () => {
		// The front page used to make no data call at all and could not fail. The
		// tape gave it one, and `getEmDashCollection` can both report an error and
		// (with no binding) throw — so both arms are handled and neither reaches
		// the visitor.
		expect(HOME).toMatch(/try\s*\{[\s\S]*getEmDashCollection[\s\S]*\}\s*catch/);
		expect(HOME).toContain("collection.error === undefined");
	});

	test("the hero fetches a hero-sized window, not the whole page cap", () => {
		// This is the site's most-hit page and every product it fetches is a row
		// joined against the commerce store. Six rows do not need forty-eight
		// joins.
		expect(HOME).toContain("TAPE_FETCH_LIMIT");
		expect(HOME).not.toContain("PLP_PAGE_SIZE_CAP");
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

	test("a degraded card says the price is UNKNOWN, not that the product is retired", () => {
		// ProductCard's default note is "Not currently available for purchase",
		// which is true of an unpriced product and false under a banner promising
		// the catalog is complete. The degraded branch overrides it.
		expect(PLP).toContain('"Price unavailable right now"');
		expect(PLP).toMatch(/<ProductCard[\s\S]{0,400}priceNote=\{priceNote\}/);
	});

	test("the eyebrow states a count only when the count is exact", () => {
		// The page renders a bounded window, so a full window means "at least 48"
		// and never "48 items". `exactCount` owns the rule; the page must not
		// print `items.length` behind its back.
		expect(PLP).toContain("exactCount(entries.length, PLP_PAGE_SIZE_CAP, hasMore)");
		expect(PLP).toMatch(/countLabel !== null && </);
		expect(PLP).not.toMatch(/\$\{count\}\s*items/);
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

	test("a sold-out PDP is not a dead end — it states the fact and offers a way on", () => {
		expect(PDP).toContain("Out of stock right now.");
		expect(PDP).toMatch(/soldOut && \([\s\S]{0,400}href="\/products"/);
	});

	test("sold out DIMS the art; degraded and unpriced do not", () => {
		// `soldOut` is the explicit token, never `!inStock`: a degraded page does
		// not know the stock, and dimming its art would state a fact it lacks.
		expect(PDP).toContain('const soldOut = product?.availability === "out_of_stock"');
		expect(PDP).toMatch(/<MediaPanel[\s\S]{0,200}dimmed=\{soldOut\}/);
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
	/**
	 * NOTE THE CLAIM, which is narrower than it looks.
	 *
	 * These sweep a page's own SOURCE, so they prove only that the theme does not
	 * AUTHOR the boast. They say nothing about what a page renders: product
	 * descriptions come from the content store, and the seeded ones currently put
	 * "No oversell under concurrency." on the screen — see the expected failure
	 * at the bottom of this block, which is where that fact is recorded.
	 */
	test.each(MIGRATED)(
		"%s authors no marketing of the inventory guarantee in its own copy",
		(_file, source) => {
			expect(source.toLowerCase()).not.toContain("oversell");
			expect(source.toLowerCase()).not.toContain("atomic");
		},
	);

	test.each(MIGRATED)("%s names no internals in the copy it authors", (_file, source) => {
		// Prose only: the frontmatter legitimately talks about the commerce
		// service and view models, and the comments explain them.
		const body = source.slice(source.indexOf("\n---", 3) + 4).replace(/<style>[\s\S]*$/, "");
		const prose = body.replace(/\{\s*\/\*[\s\S]*?\*\/\s*/g, "");
		expect(prose).not.toMatch(/commerce service|view model|\bCMS\b/i);
	});

	/**
	 * KNOWN, LIVE §10 VIOLATION — an expected failure, not a passing test.
	 *
	 * The pages above author none of this, but they render what the store holds,
	 * and the seed puts the boast straight onto the catalog and the PDP: the mug
	 * "Holds exactly one coffee, atomically. No oversell under concurrency.", the
	 * tee narrating the CMS and the commerce service, the stickers advertising
	 * integer minor units. §10 names `seed/seed.json` explicitly and assigns the
	 * rewrite to the increment that owns the seed (increment 6); increment 3 owns
	 * the templates and deliberately does not touch that file.
	 *
	 * `test.fails` makes that state legible rather than invisible: vitest counts
	 * a failing body here as a PASS, so the suite stays green while the violation
	 * stands, and the day the seed copy is fixed THIS test goes red — at which
	 * point drop the `.fails` and it becomes the guard that keeps it fixed.
	 */
	test.fails("the seeded shopper copy carries no §10 boast (owned by increment 6)", () => {
		const seed = SEED.toLowerCase();
		expect(seed).not.toContain("oversell");
		expect(seed).not.toContain("atomic");
		expect(seed).not.toContain("commerce service");
		expect(seed).not.toContain("integer minor units");
		expect(seed).not.toMatch(/\bcms\b/);
	});
});
