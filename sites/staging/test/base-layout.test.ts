/**
 * The page shell — the "Tempered" foundation (docs/theme/TEMPERED.md §2, §3,
 * §11), after the theme system split `Base.astro` in two:
 *
 *  - `src/layouts/Storefront.astro`, the ONE shell every page renders through,
 *    owns the LOGIC: the prop contract, the guarded CMS reads and their
 *    fallbacks, the nav composition, the active-theme lookup;
 *  - `src/themes/<id>/Layout.astro` owns the MARKUP: <head>, the skip link, the
 *    chrome, the footer, the faces.
 *
 * Source-text pins, same cheap pattern as base-layout-favicon.test.ts:
 * appearance is checked with Playwright, but these properties are the ones that
 * regress silently and are worth a build-breaking assertion. The markup rules
 * that every theme must keep are swept over every theme's Layout.
 *
 * The confirmation page's `no-referrer` policy and bounded meta-refresh poll
 * BOTH depend on the named `head` slot reaching <head> — THROUGH the shell and
 * into the theme's Layout. Losing either hop degrades a security control to a
 * comment.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
/** Themes with no light palette at all: their UA surfaces are dark, always. */
const DARK_ONLY: ReadonlySet<string> = new Set(["pressing"]);
const SHELL_PATH = path.join(SRC, "layouts/Storefront.astro");
const TEMPERED_LAYOUT_PATH = path.join(SRC, "themes/tempered/Layout.astro");

const shell = readFileSync(SHELL_PATH, "utf8");
const shellFrontmatter = shell.slice(0, shell.indexOf("\n---", 3));
const shellMarkup = shell.slice(shell.indexOf("\n---", 3) + 4);

/** Every theme's Layout, as `[themeId, source]`. */
const THEME_LAYOUTS: ReadonlyArray<readonly [string, string]> = readdirSync(
	path.join(SRC, "themes"),
	{ withFileTypes: true },
)
	.filter((entry) => entry.isDirectory())
	.map((entry) => [
		entry.name,
		readFileSync(path.join(SRC, "themes", entry.name, "Layout.astro"), "utf8"),
	]);

/** Everything outside the frontmatter fence (theme Layouts carry no <style>). */
const markupOf = (source: string): string => source.slice(source.indexOf("\n---", 3) + 4);

const tempered = readFileSync(TEMPERED_LAYOUT_PATH, "utf8");
const temperedMarkup = markupOf(tempered);

test("the sweep found the theme layouts — an empty list would pass every case below", () => {
	expect(THEME_LAYOUTS.map(([id]) => id)).toContain("tempered");
});

describe("Storefront shell — contract kept by the rebuild", () => {
	test("still takes `title` and an optional `description`", () => {
		expect(shell).toMatch(/title:\s*string/);
		expect(shell).toMatch(/description\?:\s*string \| null/);
	});

	test("forwards the named `head` slot into the theme Layout's own `head` slot", () => {
		expect(shellMarkup).toContain('<slot name="head" slot="head" />');
		// …and the default slot, for every page that has no themed view.
		expect(shellMarkup).toMatch(/<slot \/>/);
	});

	test.each(THEME_LAYOUTS)("%s Layout puts the named `head` slot inside <head>", (_id, source) => {
		const markup = markupOf(source);
		expect(markup).toMatch(/<slot \/>/);
		const head = markup.slice(markup.indexOf("<head>"), markup.indexOf("</head>"));
		expect(head).toContain('<slot name="head" />');
	});

	test("still reads the site title and the primary menu from the CMS", () => {
		expect(shell).toContain("getSiteSettings()");
		expect(shell).toContain('getMenu("primary")');
	});
});

/**
 * The last unguarded content read on the site, and the worst one to leave: the
 * shell renders EVERY page, so a rejected read here 500s the whole store at
 * once — including the home page and the shop page, which guard their own reads
 * and still went down with this one.
 *
 * Neither call has an error channel. `getSiteSettings()` and `getMenu()` both
 * await `getDb()` and a query behind it and reject outright; there is no
 * `{ error }` to inspect the way `getEmDashCollection` provides one. So the only
 * available guard is `try`/`catch`, on both. (The theme lookup is guarded too —
 * see theme-resolve.test.ts.)
 */
describe("Storefront shell — a dead content store costs the chrome, not the response", () => {
	test.each([
		["getSiteSettings", /try\s*\{[\s\S]*?getSiteSettings\(\)[\s\S]*?\}\s*catch/],
		["getMenu", /try\s*\{[\s\S]*?getMenu\("primary"\)[\s\S]*?\}\s*catch/],
	])("%s is read inside a try/catch", (call, guard) => {
		expect(shellFrontmatter, `${call} is awaited unguarded — that is a 500 on every page`).toMatch(
			guard,
		);
	});

	test("the title falls back exactly where an unset setting already falls back", () => {
		// A failed read lands on `{}`, so it takes the SAME path an absent
		// `settings.title` already takes rather than growing a second rule (and a
		// second string) for the store's name.
		expect(shellFrontmatter).toMatch(/settings: \{ title\?: string; tagline\?: string \} = \{\}/);
		expect(shellFrontmatter).toContain('settings.title ?? "Otta"');
	});

	test("the nav falls back to this site's own routes, and ONLY on a thrown read", () => {
		// The fallback lives in lib/nav.ts (pinned behaviourally in nav.test.ts).
		// The routes it names are defined by this site, so they resolve whatever
		// the content store is doing — which is the whole justification for
		// substituting them for an operator's menu.
		expect(shell).toContain("FALLBACK_MENU_ITEMS");
		// The gate: a menu that comes back `null` is a store with no `primary`
		// menu, which is a real answer and the operator's. Only the CATCH arm
		// substitutes. `?? []` in the try arm is what keeps those two apart.
		expect(shellFrontmatter).toMatch(
			/navItems = \(await getMenu\("primary"\)\)\?\.items \?\? \[\]/,
		);
		expect(shellFrontmatter).toMatch(/catch[\s\S]*?navItems = FALLBACK_MENU_ITEMS/);
	});

	test("both failures are logged — a silent fallback is an outage nobody sees", () => {
		expect(shellFrontmatter).toContain("[site-staging] layout settings read threw:");
		expect(shellFrontmatter).toContain("[site-staging] layout menu read threw:");
	});
});

describe("the chrome — prop contract (shell) and markup (every theme)", () => {
	test("Tempered's Layout links its token sheet by URL, and declares no raw colour of its own", () => {
		// `?url` + <link>, never a side-effect import: the registry imports every
		// theme statically, so an imported sheet would ship on every theme.
		expect(tempered).toMatch(/import \w+ from "\.\/theme\.css\?url"/);
		expect(temperedMarkup).toMatch(/<link rel="stylesheet" href=\{\w+\} \/>/);
		// Hex literals in the layout would defeat the point of the token layer.
		// (The favicon data URI is markup for an SVG, not a CSS declaration —
		// a favicon cannot read a custom property, so it is excluded.)
		const withoutFavicon = tempered.replace(/href="data:image\/svg\+xml,[^"]+"/g, "");
		expect(withoutFavicon).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	test.each(THEME_LAYOUTS)(
		"%s: a skip link is the first thing in the tab order and targets <main>",
		(_id, source) => {
			const markup = markupOf(source);
			const body = markup.slice(markup.indexOf("<body>"));
			const skip = /<a[^>]*href="#([\w-]+)"[^>]*class="[^"]*skip/.exec(body) ?? [];
			const target = skip[1];
			expect(target, "no skip link at the top of <body>").toBeDefined();
			expect(body.indexOf("<a")).toBeLessThan(body.indexOf("<header"));
			expect(body).toMatch(new RegExp(`<main[^>]*id="${target}"`));
		},
	);

	test("the cart nav item carries a live count from the page's own cart read", () => {
		// The count is a PROP, not a commerce call in the shell: a call here
		// would put the service on the critical path of every page (including
		// the home page, which by construction makes none).
		expect(shell).toMatch(/cartCount\?:\s*number \| null/);
		expect(temperedMarkup).toContain("chrome.cartCount");
	});

	test("Tempered's footer credits both halves and sets the currency in the data face", () => {
		expect(temperedMarkup).toContain("Otta — content by EmDash, commerce by Otta.");
		const footer = temperedMarkup.slice(temperedMarkup.indexOf("<footer"));
		expect(footer).toMatch(/class="[^"]*mono/);
	});

	test("the currency is a PROP, and is omitted entirely when nothing supplies it", () => {
		// §7: the chrome never invents anything money-shaped, and it cannot know
		// the store's currency on its own — a hardcoded "USD" is a lie on any
		// store not priced in dollars.
		expect(shell).toMatch(/currency\?:\s*string \| null/);
		for (const [id, source] of THEME_LAYOUTS) {
			const markup = markupOf(source);
			const footer = markup.slice(markup.indexOf("<footer"));
			expect(footer, id).toContain("chrome.currency !== null &&");
			expect(footer, `${id}: a literal currency code in the footer`).not.toMatch(
				/>\s*[A-Z]{3}\s*</,
			);
		}
	});

	test("the cart badge reads as a count to a screen reader, not as punctuation", () => {
		// Left alone, "Cart (3)" is announced "Cart left-paren three right-paren".
		expect(temperedMarkup).toContain('aria-hidden="true"');
		expect(temperedMarkup).toContain("u-sr-only");
		expect(temperedMarkup).toContain("chrome.cartCountLabel");
		expect(shell).toContain("cartCountLabel(cartCount)");
	});

	test("the nav helpers come from src/lib/nav.ts, so they can be tested for real", () => {
		// The behaviour itself is pinned in nav.test.ts. This only holds the
		// shell to using that module rather than growing its own copy.
		expect(shell).toMatch(/import \{[^}]*isCartLink[^}]*\} from "\.\.\/lib\/nav\.js"/);
		expect(shell).toContain("withAccountLink(navItems)");
	});

	test.each(THEME_LAYOUTS)(
		"%s: the dark palette is advertised to the UA so form controls follow it",
		(id, source) => {
			// "light dark" for a theme with both palettes; "dark" alone for the
			// theme that is dark ONLY by design (Pressing) — it has no light
			// palette for the UA to switch to. Keyed per theme, so no theme can
			// drift to the other value unnoticed.
			const expected = DARK_ONLY.has(id) ? "dark" : "light dark";
			expect(markupOf(source)).toMatch(
				new RegExp(`<meta\\s+name="color-scheme"\\s+content="${expected}"\\s*\\/?>`),
			);
		},
	);

	test.each([...DARK_ONLY])("%s's sheet sets color-scheme: dark, whatever the OS prefers", (id) => {
		const sheet = readFileSync(path.join(SRC, "themes", id, "theme.css"), "utf8");
		expect(sheet).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark;/);
		expect(sheet).not.toMatch(/color-scheme:\s*light/);
	});

	test("Tempered's three faces are loaded through Astro's font API, never a CDN at runtime", () => {
		// Astro exposes the font API's <Font> component from `astro:assets`.
		expect(tempered).toContain('from "astro:assets"');
		for (const face of ["display", "body", "data"]) {
			expect(tempered).toContain(`<Font cssVariable="--f-tempered-${face}"`);
		}
		// Only the faces that set real text above the fold are preloaded; the
		// data face earns its preload back in increment 4 (money, countdowns).
		expect(tempered).toContain('<Font cssVariable="--f-tempered-display" preload />');
		expect(tempered).toContain('<Font cssVariable="--f-tempered-body" preload />');
		expect(tempered).toContain('<Font cssVariable="--f-tempered-data" />');
		expect(tempered).not.toContain("fonts.googleapis.com");
		expect(tempered).not.toContain("fonts.gstatic.com");
	});
});
