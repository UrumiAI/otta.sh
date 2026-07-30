/**
 * Base layout chrome — the "Tempered" foundation (docs/theme/TEMPERED.md §2,
 * §3, §11). Source-text pins, same cheap pattern as base-layout-favicon.test.ts:
 * appearance is checked with Playwright, but these four properties are the ones
 * that regress silently and are worth a build-breaking assertion.
 *
 * The layout's PROP AND SLOT CONTRACT is pinned here too. Every page in the
 * site renders through it, and the confirmation page's `no-referrer` policy
 * and bounded meta-refresh poll BOTH depend on the named `head` slot reaching
 * <head> — losing it degrades a security control to a comment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const BASE_LAYOUT_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/layouts/Base.astro",
);

const source = readFileSync(BASE_LAYOUT_PATH, "utf8");
/** Everything outside the frontmatter fence and the <style> block. */
const markup = source.slice(source.indexOf("---", 3) + 3).split("<style>")[0] ?? "";

describe("Base layout — contract kept by the rebuild", () => {
	test("still takes `title` and an optional `description`", () => {
		expect(source).toMatch(/title:\s*string/);
		expect(source).toMatch(/description\?:\s*string \| null/);
	});

	test("still exposes the default slot and the named `head` slot inside <head>", () => {
		expect(markup).toContain('<slot name="head" />');
		expect(markup).toMatch(/<slot \/>/);
		const head = markup.slice(markup.indexOf("<head>"), markup.indexOf("</head>"));
		expect(head).toContain('<slot name="head" />');
	});

	test("still reads the site title and the primary menu from the CMS", () => {
		expect(source).toContain("getSiteSettings()");
		expect(source).toContain('getMenu("primary")');
	});
});

/**
 * The last unguarded content read on the site, and the worst one to leave: this
 * layout renders EVERY page, so a rejected read here 500s the whole store at
 * once — including the home page and the shop page, which guard their own reads
 * and still went down with this one.
 *
 * Neither call has an error channel. `getSiteSettings()` and `getMenu()` both
 * await `getDb()` and a query behind it and reject outright; there is no
 * `{ error }` to inspect the way `getEmDashCollection` provides one. So the only
 * available guard is `try`/`catch`, on both.
 */
describe("Base layout — a dead content store costs the chrome, not the response", () => {
	const frontmatter = source.slice(0, source.indexOf("\n---", 3));

	test.each([
		["getSiteSettings", /try\s*\{[\s\S]*?getSiteSettings\(\)[\s\S]*?\}\s*catch/],
		["getMenu", /try\s*\{[\s\S]*?getMenu\("primary"\)[\s\S]*?\}\s*catch/],
	])("%s is read inside a try/catch", (call, guard) => {
		expect(frontmatter, `${call} is awaited unguarded — that is a 500 on every page`).toMatch(
			guard,
		);
	});

	test("the title falls back exactly where an unset setting already falls back", () => {
		// A failed read lands on `{}`, so it takes the SAME path an absent
		// `settings.title` already takes rather than growing a second rule (and a
		// second string) for the store's name.
		expect(frontmatter).toMatch(/settings: \{ title\?: string; tagline\?: string \} = \{\}/);
		expect(frontmatter).toContain('settings.title ?? "Otta"');
	});

	test("the nav falls back to this theme's own routes, and ONLY on a thrown read", () => {
		// The fallback lives in lib/nav.ts (pinned behaviourally in nav.test.ts).
		// The routes it names are defined by this theme, so they resolve whatever
		// the content store is doing — which is the whole justification for
		// substituting them for an operator's menu.
		expect(source).toContain("FALLBACK_MENU_ITEMS");
		// The gate: a menu that comes back `null` is a store with no `primary`
		// menu, which is a real answer and the operator's. Only the CATCH arm
		// substitutes. `?? []` in the try arm is what keeps those two apart.
		expect(frontmatter).toMatch(/navItems = \(await getMenu\("primary"\)\)\?\.items \?\? \[\]/);
		expect(frontmatter).toMatch(/catch[\s\S]*?navItems = FALLBACK_MENU_ITEMS/);
	});

	test("both failures are logged — a silent fallback is an outage nobody sees", () => {
		expect(frontmatter).toContain("[site-staging] layout settings read threw:");
		expect(frontmatter).toContain("[site-staging] layout menu read threw:");
	});
});

describe("Base layout — the theme foundation", () => {
	test("imports the token sheet, and declares no raw colour of its own", () => {
		expect(source).toMatch(/import ["'].*styles\/tokens\.css["']/);
		// Hex literals in the layout would defeat the point of the token layer.
		// (The favicon data URI is markup for an SVG, not a CSS declaration —
		// a favicon cannot read a custom property, so it is excluded.)
		const withoutFavicon = source.replace(/href="data:image\/svg\+xml,[^"]+"/g, "");
		expect(withoutFavicon).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	test("a skip link is the first thing in the tab order and targets <main>", () => {
		const body = markup.slice(markup.indexOf("<body>"));
		const skip = /<a[^>]*href="#([\w-]+)"[^>]*class="[^"]*skip/.exec(body) ?? [];
		const target = skip[1];
		expect(target, "no skip link at the top of <body>").toBeDefined();
		expect(body.indexOf("<a")).toBeLessThan(body.indexOf("<header"));
		expect(body).toMatch(new RegExp(`<main[^>]*id="${target}"`));
	});

	test("the cart nav item carries a live count from the page's own cart read", () => {
		// The count is a PROP, not a commerce call in the layout: a call here
		// would put the service on the critical path of every page (including
		// the home page, which by construction makes none).
		expect(source).toMatch(/cartCount\?:\s*number \| null/);
		expect(markup).toContain("cartCount");
	});

	test("the footer credits both halves and sets the currency in the data face", () => {
		expect(markup).toContain("Otta — content by EmDash, commerce by Otta.");
		const footer = markup.slice(markup.indexOf("<footer"));
		expect(footer).toMatch(/class="[^"]*mono/);
	});

	test("the currency is a PROP, and is omitted entirely when nothing supplies it", () => {
		// §7: the layout never invents anything money-shaped, and it cannot know
		// the store's currency on its own — a hardcoded "USD" is a lie on any
		// store not priced in dollars.
		expect(source).toMatch(/currency\?:\s*string \| null/);
		const footer = markup.slice(markup.indexOf("<footer"));
		expect(footer).toContain("currency !== null &&");
		expect(footer, "a literal currency code in the footer").not.toMatch(/>\s*[A-Z]{3}\s*</);
	});

	test("the cart badge reads as a count to a screen reader, not as punctuation", () => {
		// Left alone, "Cart (3)" is announced "Cart left-paren three right-paren".
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain("u-sr-only");
		expect(source).toContain("cartCountLabel");
	});

	test("the nav helpers come from src/lib/nav.ts, so they can be tested for real", () => {
		// The behaviour itself is pinned in nav.test.ts. This only holds the
		// layout to using that module rather than growing its own copy.
		expect(source).toMatch(/import \{[^}]*isCartLink[^}]*\} from "\.\.\/lib\/nav\.js"/);
	});

	test("the dark palette is advertised to the UA so form controls follow it", () => {
		expect(markup).toMatch(/<meta\s+name="color-scheme"\s+content="light dark"\s*\/?>/);
	});

	test("the three faces are loaded through Astro's font API, never a CDN at runtime", () => {
		// Astro exposes the font API's <Font> component from `astro:assets`.
		expect(source).toContain('from "astro:assets"');
		for (const face of ["display", "body", "data"]) {
			expect(source).toContain(`<Font cssVariable="--u-face-${face}"`);
		}
		// Only the faces that set real text above the fold are preloaded; the
		// data face earns its preload back in increment 4 (money, countdowns).
		expect(source).toContain('<Font cssVariable="--u-face-display" preload />');
		expect(source).toContain('<Font cssVariable="--u-face-body" preload />');
		expect(source).toContain('<Font cssVariable="--u-face-data" />');
		expect(source).not.toContain("fonts.googleapis.com");
		expect(source).not.toContain("fonts.gstatic.com");
	});
});
