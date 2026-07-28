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

const COMPONENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/components",
);

const files = readdirSync(COMPONENTS_DIR)
	.filter((name) => name.endsWith(".astro"))
	.toSorted();

/** Just the `<style>` blocks of a component. */
function styles(name: string): string {
	const source = readFileSync(path.join(COMPONENTS_DIR, name), "utf8");
	return [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
}

/** The declaration bodies only — comments stripped, so prose about a colour is
 *  not mistaken for a colour. */
function declarations(name: string): string {
	return styles(name).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the component set §4 asks for", () => {
	test.each([
		"HoldRibbon.astro",
		"Ledger.astro",
		"MediaPanel.astro",
		"Notice.astro",
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
		const css = declarations(name);
		expect(css, "a hex literal").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css, "an rgb()/hsl() literal").not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
		expect(css, "a named colour").not.toMatch(
			/:\s*(white|black|red|green|blue|grey|gray|orange|yellow|silver)\b/,
		);
	});

	test.each(files)("%s sets type only through the face variables", (name) => {
		for (const [, value = ""] of declarations(name).matchAll(/font-family:\s*([^;]+);/g)) {
			expect(value, `${name} declares its own font stack`).toMatch(
				/var\(--u-(display|body|data)\)/,
			);
		}
	});

	test.each(files)("%s uses the theme's one radius", (name) => {
		// `var(--u-r)` for corners; `1px` is the half-height rounding of a 2–3px
		// BAR (the hold track, the stock rule, the state stamp) and `50%` is a
		// dot — neither is a corner, and neither reads as a pill.
		for (const [, value = ""] of declarations(name).matchAll(/border-radius:\s*([^;]+);/g)) {
			expect(value.trim(), `${name} invents a radius`).toMatch(/^(var\(--u-r\)|1px|50%)$/);
		}
	});

	test.each(files)("%s draws dividers with the one hairline (§2)", (name) => {
		for (const [, value = ""] of declarations(name).matchAll(/border[a-z-]*:\s*([^;]+);/g)) {
			if (!value.includes("solid")) continue;
			expect(value, `${name} writes its own solid border`).toContain("var(--u-hair)");
		}
	});

	test.each(files)("%s does not restyle focus — tokens.css owns the straw ring (§11)", (name) => {
		expect(declarations(name)).not.toMatch(/:focus/);
		expect(declarations(name)).not.toMatch(/outline\s*:/);
	});

	test.each(files)("%s uses no !important", (name) => {
		// The only legitimate use in this theme is tokens.css defending the
		// reduced-motion override against later authors.
		expect(declarations(name)).not.toContain("!important");
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

	test("only the hold ribbon animates, and it declares both sides of the rule", () => {
		const animated = files.filter((name) => /animation:|@keyframes|transition:/.test(styles(name)));
		expect(animated).toEqual(["HoldRibbon.astro"]);

		const css = styles("HoldRibbon.astro");
		// The countdown is INFORMATION and is exempted by its wrapper…
		expect(readFileSync(path.join(COMPONENTS_DIR, "HoldRibbon.astro"), "utf8")).toContain(
			'data-motion="essential"',
		);
		// …while the indeterminate sweep is decoration and settles to a static
		// filled track rather than freezing at its first keyframe.
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toContain("animation: none");
		expect(reduced).toContain("opacity: 0.4");
	});
});
