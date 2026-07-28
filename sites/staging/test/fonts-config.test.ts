/**
 * The three faces (docs/theme/TEMPERED.md §3) are self-hosted through Astro's
 * font API. Two things are worth pinning:
 *
 *  - the FACES themselves, because the display/data width contrast is the
 *    theme's loudest move and a silent substitution reads as "generic
 *    starter";
 *  - the VARIABLE AXES. `wdth` is what makes Bricolage narrow and Martian
 *    Mono wide. Google's css2 endpoint only ships an axis you asked for, so a
 *    dropped `variableAxis` option leaves `font-variation-settings: "wdth" 78`
 *    a silent no-op — the page still renders, just at the wrong widths, which
 *    no test that only checks "a font loaded" would catch.
 */
import { describe, expect, test } from "vitest";

// Match site-config.test.ts: pin the env before astro.config is imported.
process.env["COMMERCE_SERVICE_URL"] ??= "https://svc.example.com";

interface ConfiguredFont {
	name: string;
	cssVariable: string;
	provider: { name: string };
	weights?: unknown[];
	subsets?: string[];
	options?: { experimental?: { variableAxis?: Record<string, unknown> } };
}

const fonts = ((await import("../astro.config.js")).default.fonts ??
	[]) as unknown as ConfiguredFont[];
const byVariable = new Map(fonts.map((font) => [font.cssVariable, font]));

describe("astro.config fonts", () => {
	test("declares exactly the three roles: display, body, data", () => {
		expect([...byVariable.keys()].toSorted()).toEqual([
			"--u-face-body",
			"--u-face-data",
			"--u-face-display",
		]);
	});

	test.each([
		["--u-face-display", "Bricolage Grotesque"],
		["--u-face-body", "Schibsted Grotesk"],
		["--u-face-data", "Martian Mono"],
	])("%s is %s, self-hosted from the Google provider", (cssVariable, name) => {
		const font = byVariable.get(cssVariable);
		expect(font?.name).toBe(name);
		// The provider DOWNLOADS at build time; nothing is fetched from Google
		// at runtime. `local` would silently fall back to whatever the visitor
		// happens to have installed.
		expect(font?.provider.name).toBe("google");
		expect(font?.subsets).toEqual(["latin"]);
	});

	test.each([
		["--u-face-display", ["opsz", "wdth"]],
		["--u-face-data", ["wdth"]],
	])("%s requests its %s axis, so font-variation-settings is not a no-op", (cssVariable, axes) => {
		const requested = byVariable.get(cssVariable)?.options?.experimental?.variableAxis ?? {};
		expect(Object.keys(requested).toSorted()).toEqual((axes as string[]).toSorted());
	});

	test("every face is requested as a weight RANGE (one variable file, not N statics)", () => {
		for (const font of fonts) {
			expect(font.weights).toHaveLength(1);
			expect(String(font.weights?.[0])).toMatch(/^\d+ \d+$/);
		}
	});
});
