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
const TAPE_SOURCE = readFileSync(path.resolve(HERE, "../src/lib/tape.ts"), "utf8");
const SEED = readFileSync(path.resolve(HERE, "../seed/seed.json"), "utf8");

/** The pages increment 3 moved onto the token layer. Increments 4–6 add theirs. */
const MIGRATED: ReadonlyArray<readonly [string, string]> = [
	["index.astro", HOME],
	["products/index.astro", PLP],
	["products/[slug].astro", PDP],
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
		// fallback is `{}`, which `storeThesis` already resolves (see tape.ts).
		expect(HOME).toMatch(/let settings: StoreSettings = \{\}/);
		// The collection's non-throwing arm is inspected too, not just awaited.
		expect(HOME).toContain("collection.error === undefined");
	});

	test("the tape's price cell is PriceTag, not a second copy of it", () => {
		// The tape and the catalog grid must not disagree about the same product,
		// and the copy had already drifted — PriceTag pins `white-space: nowrap`
		// and the hand-rolled span did not, so a figure could break across two
		// lines in the narrow hero column. One component, one treatment.
		expect(HOME).toMatch(/<PriceTag[\s\S]{0,200}formatted=\{row\.price\}/);
		expect(HOME).toMatch(/<PriceTag[\s\S]{0,200}soldOut=\{row\.soldOut\}/);
		// And the duplicated rules are gone with it: the price cell's size,
		// weight and strike are the component's, and a page cannot reach a
		// component's root anyway (see src/lib/rest-props.ts).
		expect(declarations(HOME)).not.toMatch(/\.price\b/);
	});

	test("the tape carries table semantics — it IS a table, drawn in hairlines", () => {
		// Three labelled columns of facts. The theme draws them with divs so the
		// hero can reflow to one column on a phone; the roles put the structure
		// back for a screen reader at no visual cost.
		expect(HOME).toMatch(/role="table"/);
		expect(HOME.match(/role="row"/g)?.length).toBe(2); // the head row and the mapped one
		expect(HOME.match(/role="columnheader"/g)?.length).toBe(3);
		expect(HOME.match(/role="cell"/g)?.length).toBe(3);
		// The foot is a note, not a row, so it sits OUTSIDE the table element —
		// a `role="table"` may only contain rows.
		expect(HOME).toMatch(/<\/div>\s*<p class="tape-foot">/);
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

	test("a CONTENT outage is read from `error`, not inferred from zero entries", () => {
		// `getEmDashCollection` returns `{ entries: [], error }` and does NOT
		// throw, so an outage arrives looking exactly like an empty collection.
		// A page that only counts entries renders "No products yet." — a claim
		// about the shop, made from a fact about the network.
		expect(PLP).toMatch(/error:\s*catalogError\s*,?\s*\n?\s*\}\s*=\s*await getEmDashCollection/);
		expect(PLP).toContain("const catalogUnavailable = catalogError !== undefined");
	});

	test("the outage branch is checked BEFORE the empty state, and wins", () => {
		// Order is the whole fix: both branches see zero entries.
		expect(PLP.indexOf("catalogUnavailable ? (")).toBeGreaterThan(-1);
		expect(PLP.indexOf("catalogUnavailable ? (")).toBeLessThan(
			PLP.indexOf("items.length === 0 ? ("),
		);
	});

	test("the outage says what happened and what to do — no apology, no admin link", () => {
		// §10. The operator's next move ("create a product in the admin") is the
		// wrong instruction for a shopper and the wrong diagnosis of an outage.
		expect(PLP).toContain("The catalog is unavailable right now.");
		expect(PLP).toContain("Try again in a moment.");
		const copy = shopperCopy("products/index.astro", PLP);
		expect(copy).not.toMatch(/sorry|apolog/i);
		// Rendered once, in the branch that is not the outage.
		expect(copy.match(/_emdash\/admin/g)).toHaveLength(1);
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

	test("a sold-out PDP is not a dead end — it offers a way on", () => {
		expect(PDP).toMatch(/soldOut && \([\s\S]{0,400}href="\/products"/);
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
		expect(shopperCopy("products/[slug].astro", PDP)).not.toMatch(/out of stock/i);
	});

	test("sold out DIMS the art; degraded and unpriced do not", () => {
		// `soldOut` is the explicit token, never `!inStock`: a degraded page does
		// not know the stock, and dimming its art would state a fact it lacks.
		expect(PDP).toContain('const soldOut = product?.availability === "out_of_stock"');
		expect(PDP).toMatch(/<MediaPanel[\s\S]{0,200}dimmed=\{soldOut\}/);
	});

	test("the not-found page states the fact and speculates about nothing", () => {
		// "it may have sold out and been retired" is a story about a product the
		// page has no record of — it may never have existed, and telling a
		// shopper who followed a live link that the thing is gone is worse than
		// telling them nothing.
		expect(PDP).toContain("Nothing here under that address.");
		const copy = shopperCopy("products/[slug].astro", PDP);
		expect(copy).not.toMatch(/may have|might have|probably|perhaps/i);
		// Still a door out, which is what the empty state is for (§8).
		expect(PDP).toMatch(/Product not found\.[\s\S]{0,600}href="\/products"/);
	});

	test("the hold note states the service's DEFAULT TTL, and says so", () => {
		// @urumi/domain's DEFAULT_HOLD_TTL_MS is 15 minutes, and the mockup's
		// "10 minutes" was a draft figure. §10 keeps the hold visible to the
		// shopper — the duration is the useful part — so the number has to be
		// the true one.
		expect(PDP).toContain("holds one in stock for 15 minutes");
		// It is a DEFAULT, not a read of the effective value, and the comment
		// beside it has to keep saying that. The service's only working override
		// is the CART_HOLD_TTL_MS env var; the admin's `holdTtlMinutes` setting
		// is persisted but wired to nothing (issue #127, which names this very
		// line). A comment claiming an operator can change it in the settings
		// panel would be the page documenting a knob that does not turn.
		expect(PDP).toContain("DEFAULT_HOLD_TTL_MS");
		expect(PDP).toContain("#127");
		expect(PDP).not.toMatch(/raise it in the settings panel/);
		//
		// KNOWN DISAGREEMENT, reported with this increment: src/lib/hold.ts
		// pins `HOLD_WINDOW_SECONDS = 600` for the cart's hold ribbon, which
		// assumes ten. That file belongs to the cart increment; when it is
		// corrected to 900 this copy and that constant agree again.
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
