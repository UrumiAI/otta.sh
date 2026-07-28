/**
 * The rules every component's CSS obeys (docs/theme/TEMPERED.md §2, §4, §11).
 *
 * Scoped `<style>` blocks are resolved by Astro's build pipeline, not by the
 * Container API, so they are absent from rendered markup and cannot be asserted
 * the way the components' HTML is. They are checked from source text instead —
 * the same cheap pattern `tokens-css.test.ts` and `base-layout.test.ts` use,
 * and it catches exactly the drift that matters here: a component quietly
 * writing down a colour, a font stack, a radius or a focus ring of its own,
 * which is how a token layer stops being one.
 *
 * This suite is deliberately a SWEEP over every component rather than a check
 * on the ones that exist today: a component added in increment 3 is covered the
 * moment it lands.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, "../src");
const COMPONENTS_DIR = path.join(SRC_DIR, "components");
const FIXTURES_DIR = path.join(TEST_DIR, "fixtures");

const files = readdirSync(COMPONENTS_DIR)
	.filter((name) => name.endsWith(".astro"))
	.toSorted();

function source(name: string): string {
	return readFileSync(path.join(COMPONENTS_DIR, name), "utf8");
}

/*
 * The helpers below take a file's TEXT rather than its name. That is what lets
 * the same implementations be aimed at `test/fixtures/`, which is what lets the
 * boundary guard be checked against a file that actually breaks it — see the
 * last describe block.
 */

/** Just the `<style>` blocks of a component. */
function styles(text: string): string {
	return [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
}

/** The declaration bodies only — comments stripped, so prose about a colour is
 *  not mistaken for a colour. */
function declarations(text: string): string {
	return styles(text).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The template — everything after the frontmatter fence, minus the styles. */
function markup(text: string): string {
	const body = text.slice(text.indexOf("\n---", 3) + 4);
	return body.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script>[\s\S]*?<\/script>/g, "");
}

/** The literal class names inside one `class=` / `class:list=` attribute. */
function classesIn(attribute: string): string[] {
	const quoted = attribute.startsWith('"')
		? [attribute.slice(1, -1)]
		: [...attribute.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
	return quoted.flatMap((literal) => literal.split(/\s+/).filter(Boolean));
}

const CLASS_ATTRIBUTE = /class(?::list)?=("[^"]*"|\{[^}]*\})/g;

/** Every literal class name this component writes into its own markup. */
function classNames(text: string): string[] {
	return [...markup(text).matchAll(CLASS_ATTRIBUTE)].flatMap(([, value = ""]) => classesIn(value));
}

/**
 * Class names this component hands to a CHILD COMPONENT rather than putting on
 * an element of its own.
 *
 * "Child component" means an IMPORTED `.astro` file, which is the thing that
 * gets its own scope hash. A capitalised tag is not enough on its own:
 * `const Heading = level` is how a heading level becomes a prop, and
 * `<Heading class="headline">` renders a plain `<h1>` inside this component's
 * own template, correctly scoped.
 */
function classesPassedToChildren(text: string): string[] {
	const imported = [...text.matchAll(/^import\s+(\w+)\s+from\s+["'][^"']+\.astro["']/gm)].map(
		(m) => m[1],
	);
	if (imported.length === 0) return [];
	const tags = markup(text).matchAll(/<([A-Z]\w*)\b([^>]*?)\/?>/g);
	return [...tags]
		.filter(([, tag = ""]) => imported.includes(tag))
		.flatMap(([, , attributes = ""]) =>
			[...attributes.matchAll(CLASS_ATTRIBUTE)].flatMap(([, value = ""]) => classesIn(value)),
		);
}

describe("the component set §4 asks for", () => {
	test.each([
		"HoldRibbon.astro",
		"Ledger.astro",
		"MediaPanel.astro",
		"Notice.astro",
		"PollRibbon.astro",
		"PriceTag.astro",
		"ProductCard.astro",
		"QtyField.astro",
		"StateStamp.astro",
		"StepTrack.astro",
		"StockRule.astro",
		"Sum.astro",
	])("%s exists", (name) => {
		expect(files).toContain(name);
	});
});

describe("every component reads the token layer and writes nothing of its own", () => {
	test.each(files)("%s declares no raw colour", (name) => {
		const css = declarations(source(name));
		expect(css, "a hex literal").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css, "an rgb()/hsl() literal").not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
		expect(css, "a named colour").not.toMatch(
			/:\s*(white|black|red|green|blue|grey|gray|orange|yellow|silver)\b/,
		);
	});

	test.each(files)("%s sets type only through the face variables", (name) => {
		for (const [, value = ""] of declarations(source(name)).matchAll(/font-family:\s*([^;]+);/g)) {
			expect(value, `${name} declares its own font stack`).toMatch(
				/var\(--u-(display|body|data)\)/,
			);
		}
	});

	test.each(files)("%s uses the theme's one radius", (name) => {
		// `var(--u-r)` for corners; `1px` is the half-height rounding of a 2–3px
		// BAR (the hold track, the stock rule, the state stamp) and `50%` is a
		// dot — neither is a corner, and neither reads as a pill.
		for (const [, value = ""] of declarations(source(name)).matchAll(
			/border-radius:\s*([^;]+);/g,
		)) {
			expect(value.trim(), `${name} invents a radius`).toMatch(/^(var\(--u-r\)|1px|50%)$/);
		}
	});

	test.each(files)("%s draws dividers with the one hairline (§2)", (name) => {
		for (const [, value = ""] of declarations(source(name)).matchAll(
			/border[a-z-]*:\s*([^;]+);/g,
		)) {
			if (!value.includes("solid")) continue;
			expect(value, `${name} writes its own solid border`).toContain("var(--u-hair)");
		}
	});

	test.each(files)("%s does not restyle focus — tokens.css owns the straw ring (§11)", (name) => {
		expect(declarations(source(name))).not.toMatch(/:focus/);
		expect(declarations(source(name))).not.toMatch(/outline\s*:/);
	});

	test.each(files)("%s uses no !important", (name) => {
		// The only legitimate use in this theme is tokens.css defending the
		// reduced-motion override against later authors.
		expect(declarations(source(name))).not.toContain("!important");
	});

	test.each(files)("%s takes the shared data-face recipes rather than repeating them", (name) => {
		// §3's mono and uppercase-label tuples live once, in tokens.css, as
		// `.u-mono` and `.u-label`. Repeated per component they drift — two of
		// the first six copies had already picked up a different tracking.
		const css = declarations(source(name));
		expect(css, "re-declares the data face").not.toContain("var(--u-data)");
		expect(css, "re-declares the data face's width axis").not.toContain('"wdth" 90');
		expect(css, "re-declares the label's tracking").not.toContain("letter-spacing: 0.11em");
		expect(css, "re-declares the mono tracking").not.toContain("letter-spacing: -0.045em");
		expect(css, "re-declares tabular figures").not.toContain("font-variant-numeric");
	});
});

describe("component boundaries", () => {
	test.each(files)("%s does not style THROUGH a child component (§ scoping)", (name) => {
		// Astro scopes each component's CSS to its own hash, so a rule like
		// `.card[cid-parent] .card-media[cid-parent]` can never match a child
		// component's root — that element carries the CHILD's hash. The rule
		// compiles, ships, and silently does nothing, which is how the sold-out
		// dimming was dead on arrival. Cross-component state travels as a PROP.
		const css = declarations(source(name));
		for (const cls of classesPassedToChildren(source(name))) {
			expect(css, `${name} styles .${cls} on a child component`).not.toContain(`.${cls}`);
		}
	});

	test.each(files)("%s claims no class name that a global stylesheet owns", (name) => {
		// `legacy-bridge.css` is UNSCOPED and transitional. Its `.notice` rule
		// pins a hard-coded near-black — correct for the pale panel the
		// unmigrated pages still paint, wrong for anything else, and it wins
		// over nothing at all in a component that shares the name.
		const bridge = readFileSync(path.join(SRC_DIR, "styles/legacy-bridge.css"), "utf8").replace(
			/\/\*[\s\S]*?\*\//g,
			"",
		);
		const owned = new Set([...bridge.matchAll(/\.([\w-]+)\s*\{/g)].map((m) => m[1]));
		expect(
			owned.size,
			"legacy-bridge.css declares no class at all — check the parse",
		).toBeGreaterThan(0);
		for (const cls of classNames(source(name))) {
			expect(owned.has(cls), `${name} uses .${cls}, which legacy-bridge.css also styles`).toBe(
				false,
			);
		}
	});
});

describe("the boundary guard is not vacuous", () => {
	/*
	 * `classesPassedToChildren` returns `[]` for all eleven components today —
	 * which is the point of the rule, and also means the assertion inside that
	 * loop never executes. A regex that quietly stopped matching (an import
	 * written across two lines, a renamed default, a tag whose attributes wrap)
	 * would disable the guard entirely and every test here would stay green.
	 *
	 * So it is pointed at a fixture that DOES break the rule.
	 * `test/fixtures/StylesThroughChild.astro` passes `class="card-media"` into
	 * an imported child and then writes `.card .card-media` — the exact shape
	 * that shipped the dead sold-out dimming.
	 */
	const offender = readFileSync(path.join(FIXTURES_DIR, "StylesThroughChild.astro"), "utf8");

	test("the fixture is still the shape the guard is looking for", () => {
		expect(offender).toContain('import StyledChild from "./StyledChild.astro"');
		expect(offender).toContain('<StyledChild class="card-media" />');
	});

	test("it names the class the parent handed to an imported child", () => {
		expect(classesPassedToChildren(offender)).toContain("card-media");
	});

	test("and the rule fails on it, rather than passing an empty loop", () => {
		const css = declarations(offender);
		const passed = classesPassedToChildren(offender);
		expect(passed.length).toBeGreaterThan(0);
		expect(passed.some((cls) => css.includes(`.${cls}`))).toBe(true);
	});

	test("a capitalised tag that is NOT an imported component is not flagged", () => {
		// `const Heading = level` renders a plain <h1> inside the component's own
		// template, correctly scoped — StateStamp does exactly that and styles
		// `.headline` legitimately. Over-matching would make the guard unusable
		// rather than merely asleep.
		expect(classesPassedToChildren(source("StateStamp.astro"))).not.toContain("headline");
		expect(declarations(source("StateStamp.astro"))).toContain(".headline");
	});
});

describe("the motion budget (§2, §6, §11)", () => {
	test("only the hold ribbon ships client JavaScript", () => {
		// "One countdown, one hover" is the whole budget. A component growing a
		// script is a decision, not a detail.
		const withScripts = files.filter((name) =>
			readFileSync(path.join(COMPONENTS_DIR, name), "utf8").includes("<script"),
		);
		expect(withScripts).toEqual(["HoldRibbon.astro"]);
	});

	test("only the two ribbons animate, and each declares both sides of the rule", () => {
		const animated = files.filter((name) =>
			/animation:|@keyframes|transition:/.test(styles(source(name))),
		);
		expect(animated).toEqual(["HoldRibbon.astro", "PollRibbon.astro"]);

		// The COUNTDOWN is information a shopper is timing a decision against, so
		// it is exempted by its wrapper rather than by a media query.
		expect(readFileSync(path.join(COMPONENTS_DIR, "HoldRibbon.astro"), "utf8")).toContain(
			'data-motion="essential"',
		);

		// The indeterminate SWEEP is decoration — the count beside it is the
		// information — so it takes the clamp, and settles into a static filled
		// track rather than freezing at whichever keyframe it was on.
		const css = styles(source("PollRibbon.astro"));
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toContain("animation: none");
		expect(reduced).toContain("opacity: 0.4");
		// It must NOT claim the exemption the countdown has.
		expect(readFileSync(path.join(COMPONENTS_DIR, "PollRibbon.astro"), "utf8")).not.toContain(
			'data-motion="essential"',
		);
	});
});
