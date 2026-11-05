/**
 * Tempered's three faces (docs/theme/TEMPERED.md §3) are self-hosted through Astro's
 * font API from files checked in under `src/fonts/`. Three things are worth
 * pinning:
 *
 *  - the FACES themselves, because the display/data width contrast is the
 *    theme's loudest move and a silent substitution reads as "generic
 *    starter";
 *  - the HINTING. Astro's Google provider asks Google with a macOS user agent
 *    and is served builds with no `prep` table. An uninstructed TrueType font
 *    goes to FreeType's autohinter (Chromium on Linux/Android), which rounds
 *    each glyph's advance at text sizes, so body copy spaces unevenly. The
 *    vendored files are the builds a Windows/Linux browser gets, which carry
 *    `prep`. If someone swaps a face back to the Google provider, or drops in
 *    a file without the table (or with an empty one), these fail;
 *  - the VARIABLE AXES. `wdth` is what makes Bricolage narrow and Martian
 *    Mono wide. A file without the axis leaves
 *    `font-variation-settings: "wdth" 78` a silent no-op — the page still
 *    renders, just at the wrong widths, which no test that only checks "a font
 *    loaded" would catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { LATIN_UNICODE_RANGE, ottaFonts } from "../src/integration.js";
import { STORE_THEMES } from "../src/themes/manifest.js";
import { fvarAxes, woff2Tables } from "./helpers/woff2.js";

// (INC-D3a: this file used to pin `COMMERCE_SERVICE_URL` before importing
// astro.config, because the config resolved it at module load. The fonts now
// come from the otta() integration, which exports them, ADR-0045.)

interface ConfiguredFont {
	name: string;
	cssVariable: string;
	provider: { name: string };
	options?: {
		variants?: Array<{
			src: string[];
			weight: string;
			style?: string;
			stretch?: string;
			display?: string;
			unicodeRange?: string[];
		}>;
	};
}

// The fonts are the otta() integration's (ADR-0045): it hands Astro this list.
const fonts = ottaFonts() as ConfiguredFont[];
const byVariable = new Map(fonts.map((font) => [font.cssVariable, font]));

const here = path.dirname(fileURLToPath(import.meta.url));
const fileOf = (src: string | undefined): string => path.resolve(here, "..", src ?? "");

const FACES = [
	// [cssVariable, family, weight range, axes the theme needs in the file]
	["--f-tempered-display", "Bricolage Grotesque", "400 800", ["opsz", "wdth", "wght"]],
	["--f-tempered-body", "Schibsted Grotesk", "400 700", ["wght"]],
	["--f-tempered-data", "Martian Mono", "300 700", ["wdth", "wght"]],
] as const;

describe("otta() hands Astro this list", () => {
	// The behavioural check (the setup hook's \`fonts\` equals ottaFonts()) runs
	// through the reference site's config: sites/staging/test/site-config.test.ts.
	test("updateConfig receives the font constant itself", () => {
		const source = readFileSync(path.resolve(here, "..", "src", "integration.ts"), "utf8");
		expect(source).toMatch(/updateConfig\(\{[\s\S]*?\n\t\t\t\t\tfonts: OTTA_FONTS,/);
		expect(source).toMatch(
			/export function ottaFonts\(\): readonly unknown\[\] \{\s*return OTTA_FONTS;/,
		);
	});
});

describe("the otta() integration's fonts", () => {
	test("declares exactly each theme's roles, namespaced `--f-<theme>-<role>`", () => {
		// Namespaced per theme so a second theme's faces can never collide with
		// these; theme.css maps them onto the shared `--u-display/-body/-data`.
		// A theme that sets everything in one family declares one role; a theme
		// that pairs faces (a display face with a body face) declares one each.
		expect([...byVariable.keys()].toSorted()).toEqual([
			"--f-tempered-body",
			"--f-tempered-data",
			"--f-tempered-display",
		]);
	});

	test("every face belongs to a theme this build ships — no stray or shared variable", () => {
		// A face outside every theme's namespace is either a collision waiting to
		// happen or a download no Layout ever emits.
		const ids = STORE_THEMES.map((theme) => theme.id).join("|");
		for (const variable of byVariable.keys()) {
			expect(variable).toMatch(new RegExp(`^--f-(${ids})-[a-z]+$`));
		}
		expect(fonts).toHaveLength(byVariable.size);
	});

	describe.each(FACES)("%s (%s)", (cssVariable, name, weight, axes) => {
		const font = byVariable.get(cssVariable);
		const variants = font?.options?.variants ?? [];
		const src = variants[0]?.src[0];

		test("is the family, from the LOCAL provider, as one variable variant over a weight range", () => {
			expect(font?.name).toBe(name);
			// Not `google`: that provider is served the unhinted macOS build.
			// Nothing is fetched from Google at build time or at runtime.
			expect(font?.provider.name).toBe("local");
			expect(variants).toHaveLength(1);
			expect(variants[0]?.src).toHaveLength(1);
			expect(variants[0]?.weight).toBe(weight);
			expect(variants[0]?.style).toBe("normal");
			// Swap, as the Google provider emitted: text shows in the fallback
			// face at once rather than staying invisible while the file loads.
			expect(variants[0]?.display).toBe("swap");
			// The latin subset's range, so the browser never fetches the file for
			// text it cannot set.
			expect(variants[0]?.unicodeRange).toEqual(LATIN_UNICODE_RANGE);
			// The latin subset only, as a variable file under THIS package's
			// src/fonts/, by absolute path: the site that builds has no copy.
			expect(path.isAbsolute(src ?? "")).toBe(true);
			expect(path.relative(path.resolve(here, ".."), src ?? "")).toMatch(
				/^src\/fonts\/[a-z-]+\/[a-z-]+-variable-latin\.woff2$/,
			);
		});

		test("the file is a woff2 that carries a non-empty prep program, so it is never autohinted", () => {
			const bytes = readFileSync(fileOf(src));
			expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
			const { tags, tables } = woff2Tables(bytes);
			expect(tags).toEqual(expect.arrayContaining(["prep", "gvar", "HVAR", "GPOS"]));
			// FreeType checks the table's SIZE, not its presence: a zero-length
			// `prep` is autohinted exactly like a missing one
			// (woff2-reader.test.ts proves this assertion fails on one).
			expect(tables.get("prep")?.length ?? 0).toBeGreaterThan(0);
		});

		test(`the file carries the ${axes.join("/")} axes, so font-variation-settings is not a no-op`, () => {
			expect(fvarAxes(readFileSync(fileOf(src))).toSorted()).toEqual([...axes]);
		});

		test("ships with its OFL licence beside it", () => {
			expect(readFileSync(path.join(path.dirname(fileOf(src)), "OFL.txt"), "utf8")).toContain(
				"SIL Open Font License",
			);
		});
	});

	test("no face comes from the Google provider — every theme's faces are vendored", () => {
		// The Google provider is served builds with no `prep` table (see above),
		// so a face swapped back to it would be autohinted on Linux/Android
		// Chromium.
		expect(fonts.filter((f) => f.provider.name === "google").map((f) => f.cssVariable)).toEqual([]);
	});
});
