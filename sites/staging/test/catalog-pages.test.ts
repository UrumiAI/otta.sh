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
 * fallbacks. Those moved to `src/lib/tape.ts` and `src/lib/store-settings.ts`
 * and are covered BEHAVIOURALLY in `tape.test.ts` / `store-settings.test.ts` — a grep for `slice(0, TAPE_ROWS)` proved a line existed, not
 * that a seventh product was dropped.
 *
 * Rendered behaviour (layout, focus rings, the dark palette) is verified in a
 * workerd preview with screenshots, and is not what this file is for.
 *
 * THE THEME SPLIT. Since the theme system, each catalog page is two files: the
 * PAGE (`src/pages/…`) makes every read and every decision and builds a model;
 * the VIEW (`src/themes/tempered/{Home,Shop,Product}View.astro`) renders it,
 * styled from `themes/tempered/views.css`. Every assertion below kept its
 * intent and moved to whichever half now holds the thing it pins: decisions to
 * the page, markup to the view, CSS to the sheet.
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
const TEMPERED = path.resolve(HERE, "../src/themes/tempered");
const readView = (name: string): string => readFileSync(path.join(TEMPERED, name), "utf8");
const HOME_VIEW = readView("HomeView.astro");
const SHOP_VIEW = readView("ShopView.astro");
const PDP_VIEW = readView("ProductView.astro");
/** The CSS those three views (and the chrome) render with. */
const VIEWS_CSS = readView("views.css");
const ADD_TO_CART_FIELDS = readFileSync(
	path.resolve(HERE, "../src/forms/AddToCartFields.astro"),
	"utf8",
);
const TAPE_SOURCE = readFileSync(path.resolve(HERE, "../src/lib/tape.ts"), "utf8");
const SEED = readFileSync(path.resolve(HERE, "../seed/seed.json"), "utf8");

/** The pages increment 3 moved onto the token layer, and the views that now
 *  render them. Increments 4–6 add theirs. */
const MIGRATED: ReadonlyArray<readonly [string, string]> = [
	["index.astro", HOME],
	["products/index.astro", PLP],
	["products/[slug].astro", PDP],
	["themes/tempered/HomeView.astro", HOME_VIEW],
	["themes/tempered/ShopView.astro", SHOP_VIEW],
	["themes/tempered/ProductView.astro", PDP_VIEW],
];

/**
 * Everything the §10 copy sweeps read — the pages PLUS `src/lib/tape.ts`.
 *
 * The extraction that made the tape testable also moved shopper-facing words
 * out of the pages: "In stock", "Sold out", "Shop all 3 items" and the store's
 * fallback name are all authored in that module now. Sweeping only `src/pages`
 * would have left them uncovered, and a §10 sweep that misses where the copy
 * actually lives is worse than none.
 */
const SHOPPER_COPY: ReadonlyArray<readonly [string, string]> = [
	...MIGRATED,
	["lib/tape.ts", TAPE_SOURCE],
];

/**
 * The words a SHOPPER can read, by file kind.
 *
 * For a page that is the template body: the frontmatter and the comments are
 * engineering prose and legitimately name the commerce service, the CMS and the
 * view model — and a comment explaining a copy rule has to be free to quote the
 * wording it bans. Every block comment goes, whether it stands alone in braces
 * or sits bare inside an expression Astro is already in; the braces it leaves
 * behind are not prose and cost nothing. Anchoring the strip on the closing
 * brace instead is what NOT to do — non-greedy or not, the match then runs from
 * the first comment to whichever later one happens to end in `*​/}`, and eats
 * the page in between.
 *
 * For `tape.ts` the same distinction holds, and there the rendered copy is its
 * string literals — so that is what gets swept, with comments stripped first so
 * a `//` explaining the rule cannot trip it either.
 */
function shopperCopy(file: string, source: string): string {
	if (file.endsWith(".astro")) {
		const body = source.slice(source.indexOf("\n---", 3) + 4).replace(/<style>[\s\S]*$/, "");
		return body.replace(/\/\*[\s\S]*?\*\//g, "");
	}
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	return [...code.matchAll(/"([^"\\]*)"|`([^`\\]*)`/g)]
		.map(([, doubleQuoted, backTicked]) => doubleQuoted ?? backTicked ?? "")
		.join("\n");
}

/** The views' sheet, comments stripped — prose about a colour is not a colour.
 *  Mirrors `component-css.test.ts`, which sweeps components only. */
const declarations = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** One section of views.css, by its banner (`── Home`, `── Shop`, `── Product`). */
function section(name: string): string {
	const start = VIEWS_CSS.indexOf(`/* ── ${name}`);
	expect(start, `no ${name} section in views.css`).toBeGreaterThanOrEqual(0);
	const next = VIEWS_CSS.indexOf("/* ── ", start + 1);
	return VIEWS_CSS.slice(start, next === -1 ? undefined : next);
}

/** Each catalog view's CSS, which used to be its page's `<style>` block. */
const VIEW_SHEETS: ReadonlyArray<readonly [string, string]> = [
	["home", section("Home")],
	["shop", section("Shop")],
	["product", section("Product")],
];

describe("§2/§3 — the catalog views read the token layer and write no vocabulary of their own", () => {
	test.each(MIGRATED)(
		"%s carries no <style> block — its CSS lives in views.css",
		(_file, source) => {
			expect(source).not.toMatch(/<style[\s>]/);
		},
	);

	test.each(VIEW_SHEETS)("the %s view declares no raw colour", (_view, css) => {
		expect(declarations(css)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(declarations(css)).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
	});

	test.each(VIEW_SHEETS)("the %s view names no font family of its own", (_view, css) => {
		// `font-family: var(--u-display)` is the only legal form.
		const families = [...declarations(css).matchAll(/font-family:([^;]*);/g)].map(
			([, value = ""]) => value,
		);
		expect(families.length).toBeGreaterThan(0);
		for (const value of families) {
			expect(value).toMatch(/var\(--u-(display|body|data)\)/);
		}
	});

	test.each(VIEW_SHEETS)("the %s view uses the theme's one radius", (_view, css) => {
		const radii = [...declarations(css).matchAll(/border-radius:([^;]*);/g)].map(
			([, value = ""]) => value,
		);
		for (const value of radii) {
			expect(value).toContain("var(--u-r)");
		}
	});

	test.each(VIEW_SHEETS)("the %s view does not restyle the global focus ring", (_view, css) => {
		// §11's ring is one rule in theme.css. A view that writes its own is how
		// a store ends up with two.
		expect(declarations(css)).not.toMatch(/:focus(-visible)?\s*\{/);
	});

	test.each(MIGRATED)("%s carries no legacy `.notice` panel", (_file, source) => {
		// The pale yellow box the rollout's transitional sheet pinned ink to,
		// deleted with that sheet in increment 6. The theme's degraded surface is
		// the Notice component (§4), which has no filled background at all.
		// `page-css.test.ts` sweeps this across every page rather than these three.
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
		expect(TAPE_SOURCE).toContain("product.price.formatted");
		expect(TAPE_SOURCE).not.toMatch(/toFixed\(|Intl\.NumberFormat/);
		// Same exemption the page sweep uses: `$` only ever opens a template
		// placeholder here (the item COUNTS), never a currency symbol.
		expect(TAPE_SOURCE).not.toMatch(/\$(?!\{)/);
		expect(TAPE_SOURCE).not.toMatch(/[€£¥]/);
	});

	test("the PDP hands PriceTag the formatted string, not an amount", () => {
		expect(PDP).toContain("priceFormatted: product.price.formatted");
		expect(PDP_VIEW).toMatch(/<PriceTag[\s\S]{0,200}formatted=\{model\.purchase\.priceFormatted\}/);
		expect(PDP_VIEW).not.toMatch(/<PriceTag[\s\S]{0,200}amount=/);
	});
});

describe("§8 — the home hero and its degraded rule", () => {
	test("the tape renders only when there is at least one priced row", () => {
		// The whole degraded contract in one line: no rows ⇒ no tape. The page
		// used to make no commerce call at all, and it must still render a
		// complete hero when the commerce service is unreachable.
		expect(HOME_VIEW).toMatch(/rows\.length > 0 &&/);
		// …and the page hands over the rows it has, and nothing else.
		expect(HOME).toContain("const rows = tapeRows(view)");
	});

	test("the home cards ride the same degraded rule: no rows ⇒ no cards", () => {
		// Every theme but Tempered leads its home with `model.cards`; they must
		// vanish exactly when the tape does, so no theme shows a card for a shelf
		// the tape left out — nor a grid of "price unavailable" placeholders.
		expect(HOME).toMatch(
			/const cards: HomeModel\["cards"\] =\s*rows\.length === 0 \|\| view === null\s*\? \[\]/,
		);
		expect(HOME).not.toContain("Price unavailable");
	});

	test("a degraded home shows NO error box — that is the catalog page's job", () => {
		expect(HOME).not.toContain("Notice");
		// The view's ONE notice is the page's own one-liner (sign-out, QA2 A5),
		// never a read failure: it prints `model.notice` and nothing else.
		const notices = HOME_VIEW.match(/<Notice>[^<]*<\/Notice>/g) ?? [];
		expect(notices).toEqual(["<Notice>{model.notice}</Notice>"]);
		expect(HOME_VIEW).toMatch(/model\.notice !== null &&/);
	});

	test("the hero reads the same catalog the shop page reads", () => {
		expect(HOME).toContain("STOREFRONT_LIST_ROUTE");
		expect(HOME).toContain("dispatchOttaRoute");
	});

	test("NEITHER of the home page's own content reads can throw past it", () => {
		// The claim, stated exactly: this page's frontmatter makes two content
		// reads, and both are guarded. `getEmDashCollection` reports a query
		// failure in `error` and throws on a missing binding, so both arms are
		// handled; `getSiteSettings` has no error channel AT ALL — it awaits
		// `getDb()` and the query behind it — so it needs the try/catch outright.
		// An unguarded `await` on either is a 500 on the store's front door.
		//
		// This used to carry a caveat — that the RESPONSE did not survive a dead
		// content store, because the LAYOUT read settings on its own account and
		// was not this page's to guarantee. Increment 6 guarded that read too, so
		// the caveat is gone; `base-layout.test.ts` owns the layout's half.
		const frontmatter = HOME.slice(0, HOME.indexOf("\n---", 3));
		for (const [call, guard] of [
			["getSiteSettings", /try\s*\{[^}]*getSiteSettings[^}]*\}\s*catch/],
			["getEmDashCollection", /try\s*\{[\s\S]*getEmDashCollection[\s\S]*?\}\s*catch/],
		] as const) {
			expect(frontmatter, `${call} is read outside a try/catch`).toMatch(guard);
		}
		// And a thrown settings read must not become a placeholder name: the
		// fallback is `{}`, which `storeThesis` already resolves (see store-settings.ts).
		expect(HOME).toMatch(/let settings: StoreSettings = \{\}/);
		// The collection's non-throwing arm is inspected too, not just awaited.
		expect(HOME).toContain("collection.error === undefined");
	});

	test("the tape's price cell is PriceTag, not a second copy of it", () => {
		// The tape and the catalog grid must not disagree about the same product,
		// and the copy had already drifted — PriceTag pins `white-space: nowrap`
		// and the hand-rolled span did not, so a figure could break across two
		// lines in the narrow hero column. One component, one treatment.
		expect(HOME_VIEW).toMatch(/<PriceTag[\s\S]{0,200}formatted=\{row\.price\}/);
		expect(HOME_VIEW).toMatch(/<PriceTag[\s\S]{0,200}soldOut=\{row\.soldOut\}/);
		// And the duplicated rules are gone with it: the price cell's size,
		// weight and strike are the component's, and a view cannot reach a
		// component's root anyway (see src/lib/rest-props.ts).
		expect(declarations(section("Home"))).not.toMatch(/\.[\w-]*price\b/);
	});

	test("the tape carries table semantics — it IS a table, drawn in hairlines", () => {
		// Three labelled columns of facts. The theme draws them with divs so the
		// hero can reflow to one column on a phone; the roles put the structure
		// back for a screen reader at no visual cost.
		expect(HOME_VIEW).toMatch(/role="table"/);
		expect(HOME_VIEW.match(/role="row"/g)?.length).toBe(2); // the head row and the mapped one
		expect(HOME_VIEW.match(/role="columnheader"/g)?.length).toBe(3);
		expect(HOME_VIEW.match(/role="cell"/g)?.length).toBe(3);
		// The foot is a note, not a row, so it sits OUTSIDE the table element —
		// a `role="table"` may only contain rows.
		expect(HOME_VIEW).toMatch(/<\/div>\s*<p class="home-tape-foot">/);
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
	test("cards are NOT tinted by grid position — a product wears one colour on every page (§5)", () => {
		expect(SHOP_VIEW).not.toMatch(/index=\{index\}/);
	});

	test("a card with no live price gets `null`, not a figure and not a zero", () => {
		expect(PLP).toMatch(/price:\s*product\.purchasable[\s\S]{0,120}: null,/);
		expect(SHOP_VIEW).toMatch(/<ProductCard[\s\S]{0,400}price=\{card\.price\}/);
	});

	test("the degraded catalog still renders every product, content-only", () => {
		expect(PLP).toContain("purchasable: false");
		expect(PLP).toMatch(/degradedNotice:\s*view === null && items\.length > 0/);
		expect(SHOP_VIEW).toContain("<Notice");
	});

	test("a card on sale carries its was-price — only beside a live price, off the view model's own decision", () => {
		// The plugin decides what is a sale (`compareAtPrice` is null unless it is
		// above the price); the page only refuses to hand over a was-price for a
		// card that has no price to strike it beside.
		expect(PLP).toMatch(
			/was:\s*product\.purchasable && product\.price !== null\s*\?\s*\(product\.compareAtPrice\?\.formatted \?\? null\)\s*:\s*null/,
		);
		expect(HOME).toMatch(
			/was:\s*product\.purchasable && product\.price !== null\s*\?\s*\(product\.compareAtPrice\?\.formatted \?\? null\)\s*:\s*null/,
		);
		expect(SHOP_VIEW).toMatch(/<ProductCard[\s\S]{0,500}was=\{card\.was\}/);
	});

	test("the PDP page hands the view the plugin's was-price (the view's rendering: product-view.test.ts)", () => {
		expect(PDP).toMatch(/compareAtFormatted:\s*product\.compareAtPrice\?\.formatted \?\? null/);
	});

	test("a degraded card says the price is UNKNOWN, not that the product is retired", () => {
		// ProductCard's default note is "Not currently available for purchase",
		// which is true of an unpriced product and false under a banner promising
		// the catalog is complete. The degraded branch overrides it.
		expect(PLP).toContain('"Price unavailable right now"');
		expect(PLP).toMatch(/cards: cards\.map\([\s\S]{0,600}\bpriceNote,/);
		expect(SHOP_VIEW).toMatch(/<ProductCard[\s\S]{0,400}priceNote=\{card\.priceNote\}/);
	});

	test("the eyebrow states a count only when the count is exact", () => {
		// The page renders a bounded window, so a full window means "at least 48"
		// and never "48 items". `exactCount` owns the rule; the page must not
		// print `items.length` behind its back.
		expect(PLP).toContain("exactCount(entries.length, PLP_PAGE_SIZE_CAP, hasMore)");
		expect(SHOP_VIEW).toMatch(/model\.countLabel !== null && </);
		expect(PLP).not.toMatch(/\$\{count\}\s*items/);
	});

	test("the empty catalog is a designed state with a next move", () => {
		expect(SHOP_VIEW).toContain("No products yet.");
		expect(SHOP_VIEW).toContain("href={model.adminHref}");
		expect(PLP).toContain('adminHref: "/_emdash/admin"');
	});

	test("a CONTENT outage is read from `error`, not inferred from zero entries", () => {
		// `getEmDashCollection` returns `{ entries: [], error }` and does NOT
		// throw, so an outage arrives looking exactly like an empty collection.
		// A page that only counts entries renders "No products yet." — a claim
		// about the shop, made from a fact about the network.
		expect(PLP).toMatch(/error:\s*catalogError\s*,?\s*\n?\s*\}\s*=\s*await getEmDashCollection/);
		expect(PLP).toContain("const catalogUnavailable = catalogError !== undefined");
	});

	test("the outage branch is checked BEFORE the empty state, and wins", () => {
		// Order is the whole fix: both branches see zero entries. The page
		// decides it; the view renders the outage branch first as well.
		expect(PLP).toMatch(/catalogUnavailable\s*\?\s*"unavailable"\s*:\s*items\.length === 0/);
		const outage = SHOP_VIEW.indexOf('model.state === "unavailable" ? (');
		expect(outage).toBeGreaterThan(-1);
		expect(outage).toBeLessThan(SHOP_VIEW.indexOf('model.state === "empty" ? ('));
	});

	test("the outage says what happened and what to do — no apology, no admin link", () => {
		// §10. The operator's next move ("create a product in the admin") is the
		// wrong instruction for a shopper and the wrong diagnosis of an outage.
		expect(SHOP_VIEW).toContain("The catalog is unavailable right now.");
		expect(SHOP_VIEW).toContain("Try again in a moment.");
		const copy = shopperCopy("ShopView.astro", SHOP_VIEW);
		expect(copy).not.toMatch(/sorry|apolog/i);
		// Rendered once, in the branch that is not the outage.
		expect(copy.match(/model\.adminHref/g)).toHaveLength(1);
		expect(PLP.match(/_emdash\/admin/g)).toHaveLength(1);
	});
});

describe("the PDP's add-to-cart form is unchanged in behaviour", () => {
	test("it still posts the four fields /cart/add reads", () => {
		expect(PDP_VIEW).toMatch(/method="POST"\s+action="\/cart\/add"/);
		// The fields are the SHARED contract every theme's form renders, so no
		// theme can change what the endpoint receives.
		expect(PDP_VIEW).toMatch(
			/<form[\s\S]*?<AddToCartFields fields=\{model\.purchase\.addToCart\} \/>/,
		);
		for (const field of ["sku", "productId", "idempotencyKey", "returnTo"]) {
			expect(ADD_TO_CART_FIELDS, `${field} is no longer posted`).toMatch(
				new RegExp(`name="${field}"\\s+value=\\{`),
			);
			expect(PDP, `the page no longer supplies ${field}`).toMatch(new RegExp(`\\b${field}:`));
		}
	});

	test("the quantity field still posts `qty`, minimum one", () => {
		expect(PDP_VIEW).toMatch(/<QtyField[^>]*name="qty"/);
		expect(PDP_VIEW).toMatch(/<QtyField[^>]*min=\{1\}/);
	});

	test("the idempotency key is the plugin's, never minted here", () => {
		// Freshly minted per rendered PDP by the plugin: a double-submit of ONE
		// rendered form replays, a reload does not.
		expect(PDP).toContain("idempotencyKey: addToCart.idempotencyKey");
		for (const source of [PDP, PDP_VIEW, ADD_TO_CART_FIELDS]) {
			expect(source).not.toMatch(/randomUUID|crypto\./);
		}
	});

	test("the form only exists for a product that is actually in stock", () => {
		expect(PDP).toMatch(/addToCart && inStock\s*\?/);
		expect(PDP_VIEW).toMatch(/model\.purchase\.addToCart !== null &&/);
	});

	test("a sold-out PDP is not a dead end — it offers a way on", () => {
		expect(PDP_VIEW).toMatch(/soldOut && \([\s\S]{0,400}href="\/products"/);
	});

	test("the sold-out block says it ONCE, and the ledger is where it is said", () => {
		// The ledger's Stock row already renders "Sold out" (StockRule) and
		// PriceTag strikes the figure beside it. A third sentence restating the
		// fact is the theme repeating itself where the button should be — and
		// the round-2 draft restated it in DIFFERENT words, leaving a shopper to
		// match a second phrasing against the ledger's "Sold out".
		//
		// The RENDERED copy, not the source: the comment above that block
		// explains this rule and necessarily quotes the phrasing it bans.
		expect(shopperCopy("ProductView.astro", PDP_VIEW)).not.toMatch(/out of stock/i);
	});

	test("sold out DIMS the art; degraded and unpriced do not", () => {
		// `soldOut` is the explicit token, never `!inStock`: a degraded page does
		// not know the stock, and dimming its art would state a fact it lacks.
		expect(PDP).toContain('const soldOut = product?.availability === "out_of_stock"');
		expect(PDP).toMatch(/dimmed: soldOut,/);
		expect(PDP_VIEW).toMatch(/<MediaPanel[\s\S]{0,200}dimmed=\{model\.dimmed\}/);
	});

	test("the not-found page states the fact and speculates about nothing", () => {
		// "it may have sold out and been retired" is a story about a product the
		// page has no record of — it may never have existed, and telling a
		// shopper who followed a live link that the thing is gone is worse than
		// telling them nothing.
		expect(PDP_VIEW).toContain("Nothing here under that address.");
		const copy = shopperCopy("ProductView.astro", PDP_VIEW);
		expect(copy).not.toMatch(/may have|might have|probably|perhaps/i);
		// Still a door out, which is what the empty state is for (§8).
		expect(PDP_VIEW).toMatch(/Product not found\.[\s\S]{0,600}href="\/products"/);
	});

	test("the hold note states the EFFECTIVE hold window the route reports, not a hard-coded figure (issue #127)", () => {
		// The admin's `holdTtlMinutes` IS the cart hold now: an add stamps its deadline
		// with it, and the PDP route reports it as `cartHoldMinutes`. §10 keeps the
		// duration visible because it is the useful part, so the number has to be the
		// one the store runs — a hard-coded "15 minutes" would be false on any store
		// whose operator changed the setting.
		expect(PDP).toMatch(
			/const cartHoldMinutes = result !== null && result\.ok \? result\.cartHoldMinutes/,
		);
		expect(PDP).toMatch(/holdNote: holdNote\(cartHoldMinutes\)/);
		expect(PDP_VIEW).toMatch(/<p class="pdp-hold-note">\s*\{model\.purchase\.holdNote\}/);
		for (const source of [PDP, PDP_VIEW]) {
			expect(source).not.toContain("for 15 minutes");
			expect(source).not.toContain("CART_HOLD_TTL_MS");
		}
	});
});

describe("§10 — shopper-side copy", () => {
	/**
	 * NOTE THE CLAIM, which is narrower than it looks.
	 *
	 * These sweep a page's own SOURCE, so they prove only that the theme does not
	 * AUTHOR the boast. They say nothing about what a page RENDERS: product
	 * descriptions come from the content store, and what an operator types there
	 * after seeding is theirs. The one store state this suite can hold to the
	 * rule is the shipped seed, and the two tests at the foot of this block are
	 * where that happens — both real assertions since increment 6.
	 */
	test.each(SHOPPER_COPY)(
		"%s authors no marketing of the inventory guarantee in its own copy",
		(_file, source) => {
			expect(source.toLowerCase()).not.toContain("oversell");
			expect(source.toLowerCase()).not.toContain("atomic");
		},
	);

	test.each(SHOPPER_COPY)("%s names no internals in the copy it authors", (file, source) => {
		expect(shopperCopy(file, source)).not.toMatch(/commerce service|view model|\bCMS\b/i);
	});

	/**
	 * FIXED, AND NOW GUARDED — this was a `test.fails` tripwire through
	 * increments 3–5 and is a real assertion from increment 6.
	 *
	 * The pages author none of this, but they render what the store holds, and
	 * the seed used to put the boast straight onto the catalog and the PDP: the
	 * mug "Holds exactly one coffee, atomically. No oversell under concurrency.",
	 * the tee narrating the CMS and the commerce service, the stickers
	 * advertising integer minor units. §10 names `seed/seed.json` explicitly and
	 * assigned the rewrite to the increment that owns the seed; increment 6 did
	 * it, so the `.fails` is gone and the body stands as the guard that keeps it
	 * done.
	 *
	 * SCOPE, stated accurately rather than flatteringly. This sweeps the WHOLE
	 * seed file rather than the shopper-visible strings, which costs nothing —
	 * the seed is small and every string in it is shopper copy or an admin
	 * label — and does mean a banned PHRASE is caught wherever it is
	 * reintroduced, including a field nobody thought of. That is the only thing
	 * it does. It is a ban LIST, so anything not on the list walks through:
	 * `meta.description` in this very file says "CmsProductContent" and
	 * "widget", and passes here, because `\bcms\b` does not match inside
	 * `cmsproductcontent` and `widget` is not on this list. The list catches a
	 * REGRESSION of the four boasts increment 6 removed; the test below is what
	 * covers the shopper-facing fields properly.
	 *
	 * What neither covers: copy typed into the admin after seeding, which is the
	 * operator's and not ours to police.
	 */
	test("the seeded shopper copy carries no §10 boast", () => {
		const seed = SEED.toLowerCase();
		expect(seed).not.toContain("oversell");
		expect(seed).not.toContain("atomic");
		expect(seed).not.toContain("commerce service");
		expect(seed).not.toContain("integer minor units");
		expect(seed).not.toMatch(/\bcms\b/);
	});

	/**
	 * The other half of the seed rewrite, and the half a ban list cannot state:
	 * the copy has to be shopper copy, not just copy with the banned words taken
	 * out. One sweep for the writer's SIDE across every shopper-facing field,
	 * then three pins, one per thing that was specifically wrong.
	 */
	test("the seed's shopper-facing copy is written from the shopper's side", () => {
		const seed = JSON.parse(SEED) as {
			settings: { tagline?: string };
			menus: { items: { label: string; url: string }[] }[];
			content: { products: { slug: string; data: { description?: string } }[] };
		};

		/**
		 * Words that give away which side of the shop the writer is standing on.
		 *
		 * `deploys` earned its place: the mug shipped "Survives the dishwasher,
		 * the commute, and most deploys" through increment 6's own rewrite —
		 * none of the banned phrases, and still a joke only the operator is in
		 * on, on a product page whose whole job is to describe a mug.
		 *
		 * The check runs over EVERY shopper-facing field in the seed, not just
		 * the descriptions. The tagline is the home page's <h1> and its meta
		 * description, and the menu labels are the site nav — all three are
		 * read by more people than any one product page, and until now only the
		 * descriptions were swept.
		 */
		const INTERNALS =
			/commerce service|view model|\bCMS\b|widget|minor units|float|concurrency|\bdeploys?\b|\bdeployment\b/i;

		const shopperFacing: ReadonlyArray<readonly [string, string]> = [
			["settings.tagline", seed.settings.tagline ?? ""],
			...seed.menus.flatMap((menu) =>
				menu.items.map((item) => [`menu label "${item.label}"`, item.label] as const),
			),
			...seed.content.products.map(
				(product) => [`${product.slug} description`, product.data.description ?? ""] as const,
			),
		];
		for (const [where, text] of shopperFacing) {
			expect(text, `${where} names internals`).not.toMatch(INTERNALS);
		}

		// The TAGLINE is the home page's <h1> (`storeThesis`), set in the biggest
		// type on the site — so it has to be a thesis a shopper can read, not a
		// note about which environment this is.
		const tagline = seed.settings.tagline ?? "";
		expect(tagline.length).toBeGreaterThan(0);
		expect(tagline.toLowerCase()).not.toMatch(/staging|reference storefront|demo|test/);

		// The MENU says where the link goes. "Products" is the collection's name
		// in the admin; "Shop" is the place a shopper is going, and it is what
		// the page it lands on calls itself (`<Base title="Shop">`).
		const primary = seed.menus.find((menu) => menu.items.some((item) => item.url === "/products"));
		expect(primary?.items.find((item) => item.url === "/products")?.label).toBe("Shop");

		// And every product DESCRIPTION describes the product. The seed ships no
		// photography (§5), so on a fresh install these three sentences are the
		// only thing on the card that is about the thing being sold.
		for (const product of seed.content.products) {
			const description = product.data.description ?? "";
			expect(description.length, `${product.slug} has no description`).toBeGreaterThan(0);
		}
	});
});
