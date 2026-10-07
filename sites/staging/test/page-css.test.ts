/**
 * The rules every PAGE's CSS obeys — `component-css.test.ts`'s sweep, carried
 * across to `src/pages`, `src/layouts`, `src/forms`, every theme's `.astro`
 * files, and every theme's `views.css` — the sheet a theme's chrome and views
 * are styled from, since a theme `.astro` file may carry no `<style>` of its own
 * (docs/theme/TEMPERED.md §2, §3, §11).
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Every theme's view sheets — `views.css` (the chrome and view CSS that used
 *  to be the `<style>` blocks of `Base.astro` and the catalog pages) and any
 *  other sheet a theme ships beside it, such as Tempered's `commerce.css` (the
 *  cart, checkout, pay, order and account pages' blocks, Phase 3). Every
 *  `*.css` in a theme's directory but `theme.css`, which is the token layer
 *  itself, pinned by tokens-css.test.ts, and is exempt as tokens were. */
function viewSheets(): string[] {
	const themes = path.join(SRC_DIR, "themes");
	return readdirSync(themes, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) =>
			readdirSync(path.join(themes, entry.name))
				.filter((name) => name.endsWith(".css") && name !== "theme.css")
				.map((name) => `themes/${entry.name}/${name}`),
		);
}

/**
 * Pages, the shell, the shared forms, and every theme's templates and view
 * sheet. The chrome (was `Base.astro`) is not a page, but it renders on every
 * one of them and its rules are held to exactly the same standard — it was in
 * fact the one file carrying a second copy of `.u-mono`.
 */
const FILES = [
	...astroFiles(path.join(SRC_DIR, "pages"), "pages/"),
	...astroFiles(path.join(SRC_DIR, "layouts"), "layouts/"),
	...astroFiles(path.join(SRC_DIR, "forms"), "forms/"),
	...astroFiles(path.join(SRC_DIR, "themes"), "themes/"),
	...viewSheets(),
].toSorted();

function source(relative: string): string {
	return readFileSync(path.join(SRC_DIR, relative), "utf8");
}

/** A file's CSS: an `.astro` file's `<style>` blocks, or a sheet's whole text. */
function styles(text: string, isSheet = false): string {
	if (isSheet) return text;
	return [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
}

/** The declaration bodies only — comments stripped, so prose about a colour is
 *  not mistaken for a colour. Takes the file NAME so a `.css` sheet is read whole. */
function declarations(name: string): string {
	return styles(source(name), name.endsWith(".css")).replace(/\/\*[\s\S]*?\*\//g, "");
}

const THEME_SHEET = "themes/tempered/theme.css";

test("the sweep found the pages — an empty list would pass every case below", () => {
	expect(FILES.length).toBeGreaterThan(8);
	expect(FILES).toContain("layouts/Storefront.astro");
	expect(FILES).toContain("themes/tempered/Layout.astro");
	expect(FILES).toContain("themes/tempered/views.css");
	expect(FILES).toContain("themes/tempered/commerce.css");
	expect(FILES).toContain("pages/404.astro");
	expect(FILES).toContain("pages/cart/index.astro");
});

describe("every page reads the token layer and writes nothing of its own", () => {
	test.each(FILES)("%s declares no raw colour", (name) => {
		const css = declarations(name);
		expect(css, "a hex literal").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css, "an rgb()/hsl() literal").not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
		// NOT anchored on `:` — that only saw `color: white` and walked straight
		// past `border: 1px solid white` and `linear-gradient(white, …)`, which
		// are the two places a literal actually turns up. A named colour is
		// banned as a TOKEN wherever it appears in a declaration.
		//
		// The lookarounds are what keep `white-space: nowrap` and
		// `--u-blue-ish` out of it: a colour name is a whole word here, and a
		// hyphen on either side means it is part of a longer identifier.
		expect(css, "a named colour").not.toMatch(
			/(?<![\w-])(white|black|red|green|blue|grey|gray|orange|yellow|silver)(?![\w-])/,
		);
	});

	test.each(FILES)("%s sets type only through the face variables", (name) => {
		for (const [, value = ""] of declarations(name).matchAll(/font-family:\s*([^;]+);/g)) {
			expect(value, `${name} declares its own font stack`).toMatch(
				/var\(--u-(display|body|data)\)/,
			);
		}
	});

	test.each(FILES)("%s takes its corners from the theme's radius tokens", (name) => {
		// `var(--u-r)` for corners; `1px` is the half-height rounding of a 2–3px
		// bar, `50%` is a dot and `0` is no corner at all. Tempered has exactly
		// one radius, so for it this IS "the one radius". A theme whose brief
		// gives radii by ROLE (control / button / media / panel /
		// pill, say) names them as tokens in its own theme.css — `var(--<prefix>-r-<role>)` — so a corner
		// is still never a raw length written in a view.
		for (const [, value = ""] of declarations(name).matchAll(/border-radius:\s*([^;]+);/g)) {
			expect(value.trim(), `${name} invents a radius`).toMatch(
				/^(var\(--u-r\)|var\(--[a-z]+-r-[a-z]+\)|0|1px|50%)$/,
			);
		}
	});

	test.each(FILES)("%s draws solid dividers with the one hairline (§2)", (name) => {
		for (const [, value = ""] of declarations(name).matchAll(/border[a-z-]*:\s*([^;]+);/g)) {
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
		//
		// The LONGHANDS count. `outline-style: none` and `outline-width: 0` each
		// erase the ring on their own, and the shorthand-only form of this rule
		// let both through — which a reviewer demonstrated rather than supposed.
		expect(declarations(name)).not.toMatch(/outline[-a-z]*\s*:/);
	});

	test.each(FILES)("%s uses no !important", (name) => {
		// The only legitimate use in this theme is tokens.css defending the
		// reduced-motion override against later authors.
		expect(declarations(name)).not.toContain("!important");
	});

	test.each(FILES)("%s takes the shared data-face recipes rather than repeating them", (name) => {
		// §3's mono and uppercase-label tuples live once, in tokens.css, as
		// `.u-mono` and `.u-label`. `Base.astro` had a private copy of the first
		// one until increment 6.
		const css = declarations(name);
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
		const css = declarations(name);
		// EVERY rule, then a look at the selector — not "every rule whose
		// selector STARTS with a `.btn`-ish class", which is what this was. The
		// anchor made `.card .btn { background: … }` and `.panel > .btn { … }`
		// invisible to it, and a reviewer walked a fresh button shape past it
		// that way. The selector is now searched rather than matched from its
		// head, so where the class sits in it does not matter.
		//
		// `[^{}]` on both sides is what lets a flat regex read nested rules: a
		// selector cannot contain a brace, so the engine slides past
		// `@media (…) {` and matches the rules inside it.
		//
		// `.link-btn` on the cart is deliberately not one of these — it is an
		// underlined text control, and it is excluded by the word boundary
		// rather than by name.
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
		for (const [, selector = "", body = ""] of rules) {
			if (!/\.[\w-]*\bbtn\b[\w-]*/.test(selector)) continue;
			if (selector.includes("link-btn")) continue;
			expect(
				BUTTON_PROPERTIES.test(body),
				`${name} re-declares the button shape in \`${selector.trim()}\` — it belongs in tokens.css`,
			).toBe(false);
		}
	});

	test("the one exemption still pays its own way: `.link-btn` keeps a 24px target (§11)", () => {
		// The exemption above lets the cart's `Update`/`Remove` out of the button
		// shape, and out of the button's padding with it — which is why those two
		// controls measured 41×15 and 47×15px, two adjacent targets on a phone
		// both under WCAG 2.5.8's 24px minimum. `min-height` is what buys the
		// height back, and it is pinned here rather than anywhere else so it sits
		// beside the exemption that makes it necessary.
		//
		// `display` is pinned with it because the fix is the PAIR, not the one
		// declaration: `min-height` sets the box, and `inline-flex` +
		// `align-items: center` is what keeps the 12px label on the optical line
		// it was already on as that box grows. Pinning the height alone would let
		// a tidy-up drop the other half and move every cart row's text.
		//
		// The rule moved with the cart's markup into Tempered's commerce sheet
		// (Phase 3), namespaced as `.cart-link-btn`; the exemption above still
		// reaches it by the `link-btn` word.
		const css = declarations("themes/tempered/commerce.css");
		const [, rule = ""] = /\.cart-link-btn\s*\{([^}]*)\}/.exec(css) ?? [];
		expect(rule, "no `.cart-link-btn` rule in the commerce sheet").not.toBe("");
		expect(rule, "the 24px tap-target floor").toMatch(/min-height:\s*1\.5rem/);
		expect(rule, "what makes min-height apply").toMatch(/display:\s*inline-flex/);
	});

	test.each(FILES)("%s does not redefine a class the global sheet owns", (name) => {
		// Same rule the component sweep applies: `.u-` classes may be USED
		// anywhere — that is what they are for — but a scoped redefinition beats
		// the global on specificity and forks the vocabulary.
		//
		// WHAT COUNTS AS A REDEFINITION is the head COMPOUND, not the head class.
		// `.u-btn.compact`, `a.u-btn` and `.u-btn:hover` all select the same
		// element the global rule does and all outrank it, and the old anchor
		// (`.u-btn` followed by one of `[\s,:{]`) saw only the last of those —
		// a chained class walked through. So the compound at the head of each
		// complex selector is extracted whole and searched.
		//
		// Qualifying one from OUTSIDE (`.ship .u-mono { font-size: … }`) stays
		// allowed: a combinator means the rule is reaching a descendant from a
		// context it owns, which is how a page adjusts a shared class to its
		// surroundings. That allowance is not free, and is worth naming rather
		// than assuming: `.buy .u-btn { background: … }` forks the button's
		// SHAPE just as thoroughly as redefining `.u-btn` would, it just does it
		// in one place. The line drawn here is who the rule belongs to, not what
		// it can reach — the properties are covered by the shape sweep above.
		const tokens = readFileSync(path.join(SRC_DIR, THEME_SHEET), "utf8").replace(
			/\/\*[\s\S]*?\*\//g,
			"",
		);
		const owned = new Set(
			[...tokens.matchAll(/(?:^|[,{}])\s*(\.u-[\w-]+)[\s,:{]/gm)].map((m) => m[1] ?? ""),
		);
		expect(owned.size, "tokens.css declares no `.u-` class — check the parse").toBeGreaterThan(0);
		const css = declarations(name);
		const heads = [
			...css.matchAll(
				/(?:^|[,{}])\s*([a-zA-Z]*(?:\.[\w-]+|\[[^\]]*\]|:{1,2}[\w-]+(?:\([^)]*\))?)+)/g,
			),
		].map((m) => m[1] ?? "");
		for (const cls of owned) {
			const chained = new RegExp(`\\${cls}(?![\\w-])`);
			for (const head of heads) {
				expect(head, `${name} redefines ${cls}, which tokens.css owns`).not.toMatch(chained);
			}
		}
	});
});

const MOTION = /animation[-a-z]*\s*:|transition[-a-z]*\s*:|@keyframes/;

/** A view sheet of any theme but Tempered — the one theme whose budget is zero.
 *  Every sheet such a theme ships beside its token layer (its `views.css`, and
 *  e.g. a `commerce.css` for its commerce views, or a bag drawer's). */
function isOtherThemeSheet(name: string): boolean {
	return /^themes\/[^/]+\/[\w-]+\.css$/.test(name) && !name.startsWith("themes/tempered/");
}

/** Split `css` into what lies OUTSIDE every `@media (prefers-reduced-motion: <mode>)`
 *  block and the blocks' own contents (braces balanced, so nested rules go with them). */
function splitMotionQuery(css: string, mode: "no-preference" | "reduce"): [string, string[]] {
	const opener = new RegExp(
		`@media\\s*\\(\\s*prefers-reduced-motion:\\s*${mode}\\s*\\)\\s*\\{`,
		"g",
	);
	let out = "";
	const blocks: string[] = [];
	let from = 0;
	for (let match = opener.exec(css); match !== null; match = opener.exec(css)) {
		out += css.slice(from, match.index);
		let depth = 1;
		let i = match.index + match[0].length;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}") depth--;
		}
		blocks.push(css.slice(match.index + match[0].length, i - 1));
		from = i;
		opener.lastIndex = i;
	}
	return [out + css.slice(from), blocks];
}

/** The CSS with every `@media (prefers-reduced-motion: no-preference) { … }` removed. */
function withoutNoPreference(css: string): string {
	return splitMotionQuery(css, "no-preference")[0];
}

describe("the motion budget, at page scope (§2, §6, §11)", () => {
	test("no page animates: the theme's only motion is the two ribbons and the button", () => {
		// The component sweep pins that HoldRibbon and PollRibbon are the only
		// animated components. This is its other half: after increment 6 promoted
		// the button, the pages declare no `transition`, no `animation` and no
		// `@keyframes` at all. The one page-level transition left in the theme —
		// the button's 120ms hover — is a single declaration in tokens.css, inside
		// the reach of that file's own `prefers-reduced-motion` clamp.
		//
		// LONGHANDS included: `transition-property` plus `transition-duration`
		// animates exactly as much as `transition:` does, and `animation-name`
		// is the whole of an animation once a `@keyframes` exists. The
		// shorthand-only form of this was walked past by a reviewer writing the
		// longhands, which is the same evasion the focus rule allowed.
		//
		// Swept over `declarations()`, not `styles()`: over raw style text a
		// COMMENT mentioning `transition:` — and there is one in this very
		// theme — fails the test, which trains the next author to phrase the
		// prose around the tripwire instead of the rule around the CSS.
		//
		// THIS BUDGET IS TEMPERED'S. Another theme's `views.css` may carry its
		// own authored motion (a card → product morph, a hover crossfade) —
		// the rule for those is the next test, not this one.
		const animated = FILES.filter((name) => !isOtherThemeSheet(name)).filter((name) =>
			MOTION.test(declarations(name)),
		);
		expect(animated).toEqual([]);
	});

	test.each(FILES.filter(isOtherThemeSheet))(
		"%s keeps every transition and animation inside prefers-reduced-motion: no-preference",
		(name) => {
			// A theme other than Tempered may animate — each has one authored
			// motion moment — but only for a visitor who has not asked for less.
			// Strip the `no-preference` blocks (braces balanced, so nested rules
			// go with them) and nothing that moves may be left. LONGHANDS count,
			// as above, and so does `view-transition-name`: naming an element is
			// what makes it morph.
			// The one thing allowed outside them is the brief's reduced-motion
			// VARIANT — a plain fade — inside `prefers-reduced-motion: reduce`,
			// held to exactly that by the next test.
			const [rest] = splitMotionQuery(withoutNoPreference(declarations(name)), "reduce");
			expect(rest).not.toMatch(MOTION);
		},
	);

	test.each(FILES.filter(isOtherThemeSheet))(
		"%s: under reduced motion, nothing moves — at most a fade",
		(name) => {
			// A reduced-motion block may carry the brief's fade (a drawer, say:
			// 150ms of opacity instead of the slide), and the discrete `display` /
			// `overlay` a top-layer element needs to fade out at all. Nothing that
			// MOVES: no transform, translate, scale, animation or keyframes.
			const [, reduced] = splitMotionQuery(withoutNoPreference(declarations(name)), "reduce");
			for (const block of reduced) {
				expect(block, `${name} animates under reduced motion`).not.toMatch(
					/animation[-a-z]*\s*:|@keyframes|view-transition-name/,
				);
				for (const [, value = ""] of block.matchAll(/transition[-a-z]*\s*:([^;]+);/g)) {
					for (const part of value.split(",")) {
						expect(part.trim(), `${name}: a reduced-motion transition that is not a fade`).toMatch(
							/^(opacity|display|overlay)\s/,
						);
					}
				}
				expect(block, `${name} moves something under reduced motion`).not.toMatch(
					/(?<![\w-])(transform|translate|scale|rotate)\s*:/,
				);
			}
		},
	);

	test("and the shared button's transition is covered by the reduced-motion clamp", () => {
		const tokens = readFileSync(path.join(SRC_DIR, THEME_SHEET), "utf8");
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
		// `src/styles/` held tokens.css alone after increment 6; the theme system
		// moved that to `themes/tempered/theme.css`, so the directory is gone, and
		// a theme's stylesheets are exactly its token sheet and its view sheet.
		expect(existsSync(path.join(SRC_DIR, "styles"))).toBe(false);
		//
		// Phase 3 added exactly one, deliberately: `commerce.css`, the cart,
		// checkout, pay, order and account views' sheet — every theme's
		// fallback, so linked by the shell on those pages rather than by
		// Tempered's Layout (see themes/registry.ts `fallbackSheetFor`).
		expect(
			readdirSync(path.join(SRC_DIR, "themes/tempered"))
				.filter((name) => name.endsWith(".css"))
				.toSorted(),
		).toEqual(["commerce.css", "theme.css", "views.css"]);
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
		for (const sheet of viewSheets()) {
			expect(declarations(sheet), sheet).not.toMatch(/main\s*\{[^}]*overflow/);
		}
	});
});
