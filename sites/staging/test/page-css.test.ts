/**
 * The rules every PAGE's CSS obeys — `component-css.test.ts`'s sweep, carried
 * across to `src/pages` and `src/layouts` (docs/theme/TEMPERED.md §2, §3, §11).
 *
 * The component sweep has existed since increment 2 and is the reason the
 * components never drifted. The pages had no equivalent, and they drifted
 * exactly as much as that predicts: by increment 5, seven of them carried a
 * private copy of the button shape, three of those copies wrote the transparent
 * inset shadow as `rgba(0, 0, 0, 0)` and four as `transparent`, one page had
 * redefined `.btn` to mean the GHOST variant so `class="btn"` drew two
 * different buttons in two places, and the layout carried a private copy of
 * `.u-mono`. Increment 6 de-duplicated all of it; this file is what stops it
 * coming back.
 *
 * It is a SWEEP over whatever is on disk, not a list: a page added tomorrow is
 * covered the moment it lands. Scoped `<style>` blocks are resolved by Astro's
 * build pipeline rather than by the Container API, so — like the component
 * suite — this reads source text.
 *
 * What it deliberately does NOT check: layout, spacing, or anything a
 * screenshot answers better. These are the properties that regress silently.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, "../src");

/** Every `.astro` file under a directory, recursively, as a repo-relative path. */
function astroFiles(dir: string, prefix: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory()) {
			return astroFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`);
		}
		return entry.name.endsWith(".astro") ? [`${prefix}${entry.name}`] : [];
	});
}

/**
 * Pages AND layouts. `Base.astro` is not a page, but it renders on every one of
 * them and its `<style>` block is held to exactly the same rules — it was in
 * fact the one file carrying a second copy of `.u-mono`.
 */
const FILES = [
	...astroFiles(path.join(SRC_DIR, "pages"), "pages/"),
	...astroFiles(path.join(SRC_DIR, "layouts"), "layouts/"),
].toSorted();

function source(relative: string): string {
	return readFileSync(path.join(SRC_DIR, relative), "utf8");
}

/** A file's `<style>` blocks. */
function styles(text: string): string {
	return [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
}

/** The declaration bodies only — comments stripped, so prose about a colour is
 *  not mistaken for a colour. */
function declarations(text: string): string {
	return styles(text).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the sweep found the pages — an empty list would pass every case below", () => {
	expect(FILES.length).toBeGreaterThan(8);
	expect(FILES).toContain("layouts/Base.astro");
	expect(FILES).toContain("pages/404.astro");
	expect(FILES).toContain("pages/cart/index.astro");
});

describe("every page reads the token layer and writes nothing of its own", () => {
	test.each(FILES)("%s declares no raw colour", (name) => {
		const css = declarations(source(name));
		expect(css, "a hex literal").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css, "an rgb()/hsl() literal").not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
		expect(css, "a named colour").not.toMatch(
			/:\s*(white|black|red|green|blue|grey|gray|orange|yellow|silver)\b/,
		);
	});

	test.each(FILES)("%s sets type only through the face variables", (name) => {
		for (const [, value = ""] of declarations(source(name)).matchAll(/font-family:\s*([^;]+);/g)) {
			expect(value, `${name} declares its own font stack`).toMatch(
				/var\(--u-(display|body|data)\)/,
			);
		}
	});

	test.each(FILES)("%s uses the theme's one radius", (name) => {
		// `var(--u-r)` for corners; `1px` is the half-height rounding of a 2–3px
		// bar and `50%` is a dot — neither is a corner.
		for (const [, value = ""] of declarations(source(name)).matchAll(
			/border-radius:\s*([^;]+);/g,
		)) {
			expect(value.trim(), `${name} invents a radius`).toMatch(/^(var\(--u-r\)|1px|50%)$/);
		}
	});

	test.each(FILES)("%s draws solid dividers with the one hairline (§2)", (name) => {
		for (const [, value = ""] of declarations(source(name)).matchAll(
			/border[a-z-]*:\s*([^;]+);/g,
		)) {
			if (!value.includes("solid")) continue;
			// TWO exemptions, and both are §2's own sentence rather than a hole in
			// it: "straw is a fitting — the focus ring, the hover underline, the
			// wordmark's rule". Those are MARKS, not dividers, and the transparent
			// form is the same mark reserving its space so it slides in on hover
			// instead of appearing from nothing. The hairline rule still binds
			// everything that is actually separating two things.
			if (value.includes("var(--u-straw)") || value.includes("transparent")) continue;
			expect(value, `${name} writes its own solid border`).toContain("var(--u-hair)");
		}
	});

	test.each(FILES)("%s does not restyle focus — tokens.css owns the straw ring (§11)", (name) => {
		// Narrower than the component rule, deliberately. Components are forbidden
		// `:focus` outright; a page may need it, and exactly one does — the skip
		// link is `position: absolute` until `:focus` drops it into flow, which is
		// behaviour rather than decoration and cannot live anywhere else. What no
		// page may do is touch the RING, so that is what is pinned: any `outline`
		// declaration at all, including `outline: none`.
		expect(declarations(source(name))).not.toMatch(/outline\s*:/);
	});

	test.each(FILES)("%s uses no !important", (name) => {
		// The only legitimate use in this theme is tokens.css defending the
		// reduced-motion override against later authors.
		expect(declarations(source(name))).not.toContain("!important");
	});

	test.each(FILES)("%s takes the shared data-face recipes rather than repeating them", (name) => {
		// §3's mono and uppercase-label tuples live once, in tokens.css, as
		// `.u-mono` and `.u-label`. `Base.astro` had a private copy of the first
		// one until increment 6.
		const css = declarations(source(name));
		expect(css, "re-declares the data face").not.toContain("var(--u-data)");
		expect(css, "re-declares the data face's width axis").not.toContain('"wdth" 90');
		expect(css, "re-declares the label's tracking").not.toContain("letter-spacing: 0.11em");
		expect(css, "re-declares the mono tracking").not.toContain("letter-spacing: -0.045em");
		expect(css, "re-declares tabular figures").not.toContain("font-variant-numeric");
	});
});

describe("the shared button shape is shared (§2)", () => {
	/**
	 * The de-duplication increment 6 performed, pinned so it stays performed.
	 *
	 * `.u-btn` is a GLOBAL in tokens.css rather than a component, and that is not
	 * a shortcut: a page cannot style a component's root (src/lib/rest-props.ts),
	 * and every button in this theme is a `<button>` inside a form the page owns
	 * or an `<a>` the page positions — so the page needs the element, and a class
	 * it can put on that element is the only shape that fits.
	 */
	const BUTTON_PROPERTIES = /(background|padding|box-shadow|font-weight|border-radius)/;

	test.each(FILES)("%s declares no button shape of its own", (name) => {
		const css = declarations(source(name));
		// Any rule whose selector is a bare `.btn`-ish class. `.link-btn` on the
		// cart is deliberately NOT one — it is an underlined text control, and it
		// is excluded by the word boundary rather than by name.
		const rules = [...css.matchAll(/(?:^|[,{}])\s*(\.[\w-]*\bbtn\b[\w-]*)([^{]*)\{([^}]*)\}/g)];
		for (const [, selector = "", , body = ""] of rules) {
			if (selector.includes("link-btn")) continue;
			expect(
				BUTTON_PROPERTIES.test(body),
				`${name} re-declares the button shape in ${selector} — it belongs in tokens.css`,
			).toBe(false);
		}
	});

	test.each(FILES)("%s does not redefine a class the global sheet owns", (name) => {
		// Same rule the component sweep applies: `.u-` classes may be USED
		// anywhere — that is what they are for — but a scoped redefinition beats
		// the global on specificity and forks the vocabulary. Qualifying one from
		// outside (`.ship .u-mono { font-size: … }`) stays allowed.
		const tokens = readFileSync(path.join(SRC_DIR, "styles/tokens.css"), "utf8").replace(
			/\/\*[\s\S]*?\*\//g,
			"",
		);
		const owned = new Set(
			[...tokens.matchAll(/(?:^|[,{}])\s*(\.u-[\w-]+)[\s,:{]/gm)].map((m) => m[1] ?? ""),
		);
		expect(owned.size, "tokens.css declares no `.u-` class — check the parse").toBeGreaterThan(0);
		const css = declarations(source(name));
		for (const cls of owned) {
			expect(css, `${name} redefines ${cls}, which tokens.css owns`).not.toMatch(
				new RegExp(`(^|[,{}])\\s*\\${cls}[\\s,:{]`, "m"),
			);
		}
	});
});

describe("the motion budget, at page scope (§2, §6, §11)", () => {
	test("no page animates: the theme's only motion is the two ribbons and the button", () => {
		// The component sweep pins that HoldRibbon and PollRibbon are the only
		// animated components. This is its other half: after increment 6 promoted
		// the button, the pages declare no `transition`, no `animation` and no
		// `@keyframes` at all. The one page-level transition left in the theme —
		// the button's 120ms hover — is a single declaration in tokens.css, inside
		// the reach of that file's own `prefers-reduced-motion` clamp.
		const animated = FILES.filter((name) =>
			/animation:|@keyframes|transition:/.test(styles(source(name))),
		);
		expect(animated).toEqual([]);
	});

	test("and the shared button's transition is covered by the reduced-motion clamp", () => {
		const tokens = readFileSync(path.join(SRC_DIR, "styles/tokens.css"), "utf8");
		expect(tokens).toMatch(/\.u-btn\s*\{[^}]*transition:/);
		// The clamp is a `*` selector exempting only `data-motion="essential"`, and
		// the button does not claim that exemption — the hold countdown is the one
		// thing in the theme that does (§6).
		expect(tokens).toContain("@media (prefers-reduced-motion: reduce)");
		expect(tokens).toMatch(/\.u-btn\s*\{(?:(?!\})[\s\S])*\}/);
		expect(/\.u-btn[^{]*\{[^}]*data-motion/.test(tokens)).toBe(false);
	});
});

describe("the transitional bridge is gone (increment 6)", () => {
	test("nothing imports it, and the file does not exist", () => {
		expect(readdirSync(path.join(SRC_DIR, "styles"))).toEqual(["tokens.css"]);
		for (const name of FILES) {
			expect(source(name), `${name} still imports the bridge`).not.toContain("legacy-bridge");
		}
	});

	test("no page paints the pre-theme notice panel any more", () => {
		// The pale yellow box. The theme's degraded surface is the Notice
		// component (§4) — dashed bronze rules and NO filled background.
		for (const name of FILES) {
			expect(source(name), `${name} still renders a legacy notice`).not.toMatch(/class="notice"/);
		}
	});

	test("<main> is no longer a scroll container", () => {
		// `overflow-x: auto` on <main> was the transitional fix for the pre-theme
		// cart and checkout tables, and it cost real behaviour: it forces
		// overflow-y to auto as well, so a `position: sticky` descendant sticks to
		// <main> rather than to the viewport, and browsers may hand the scrollable
		// region an implicit tab stop. §11's rule is that WIDE CONTENT scrolls
		// inside its own container, which is where it now happens.
		expect(declarations(source("layouts/Base.astro"))).not.toMatch(/main\s*\{[^}]*overflow/);
	});
});
