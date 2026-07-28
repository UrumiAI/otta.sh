/**
 * The "Tempered" token layer (docs/theme/TEMPERED.md §2–§3).
 *
 * `src/styles/tokens.css` is the single place a colour or a font stack is
 * allowed to be written down; every page reads the custom properties. These
 * are source-text pins (same cheap pattern as base-layout-favicon.test.ts) —
 * they exist to catch the two failures that are invisible in a screenshot:
 *
 *  1. a token defined in light but forgotten in dark (or vice versa), which
 *     silently falls back to the light value on a dark ground;
 *  2. the explicit `data-theme` toggle failing to beat the OS preference in
 *     ONE direction — the classic bug where "force light" works on a
 *     light-preference machine and does nothing on a dark-preference one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const TOKENS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/styles/tokens.css",
);

const source = readFileSync(TOKENS_PATH, "utf8");

/** The declarations inside the first block whose selector/prelude matches. */
function blockBody(prelude: string): string {
	const start = source.indexOf(prelude);
	expect(start, `no \`${prelude}\` block in tokens.css`).toBeGreaterThanOrEqual(0);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	throw new Error(`unbalanced braces after \`${prelude}\``);
}

/** `--u-ink: #131A20;` → `#131a20`. */
function declared(body: string, token: string): string | undefined {
	const match = new RegExp(`(?:^|[;{\\s])${token}\\s*:\\s*([^;]+);`).exec(body);
	return match?.[1]?.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Every token that must carry BOTH a light and a dark value. */
const THEMED = [
	"--u-ink",
	"--u-ground",
	"--u-surface",
	"--u-edge",
	"--u-mute",
	"--u-straw",
	"--u-violet",
	"--u-bronze",
	"--u-panel",
	"--u-tint-violet",
	"--u-tint-straw",
	"--u-tint-blue",
] as const;

const LIGHT: Record<string, string> = {
	"--u-ink": "#131a20",
	"--u-ground": "#f1f4f4",
	"--u-surface": "#ffffff",
	"--u-edge": "#d2dad9",
	"--u-mute": "#5a6a70",
	"--u-straw": "#8a6412",
	"--u-violet": "#6b4c9e",
	"--u-bronze": "#96541f",
	"--u-panel": "rgba(19, 26, 32, 0.05)",
	"--u-tint-violet": "#6b4c9e",
	"--u-tint-straw": "#8a6412",
	"--u-tint-blue": "#1f3d6b",
};

const DARK: Record<string, string> = {
	"--u-ink": "#e7edec",
	"--u-ground": "#0f1418",
	"--u-surface": "#171e22",
	"--u-edge": "#2b363b",
	"--u-mute": "#8fa0a6",
	"--u-straw": "#e0ac3a",
	"--u-violet": "#ae93de",
	"--u-bronze": "#d68f4e",
	"--u-panel": "rgba(231, 237, 236, 0.055)",
	"--u-tint-violet": "#ae93de",
	"--u-tint-straw": "#e0ac3a",
	"--u-tint-blue": "#6e9bd8",
};

describe("tokens.css — light defaults", () => {
	const root = blockBody(":root {");

	test.each(THEMED)("%s carries its specced light value", (token) => {
		expect(declared(root, token)).toBe(LIGHT[token]);
	});

	test("structural tokens: a 2px blade edge and the one hairline", () => {
		expect(declared(root, "--u-r")).toBe("2px");
		expect(declared(root, "--u-hair")).toBe("1px solid var(--u-edge)");
	});

	test("the coil fill opacity is a token, not a magic number in a component", () => {
		expect(declared(root, "--u-coil-a")).toBe("0.5");
	});

	test("the three faces are declared as stacks with no silent fallback beyond them", () => {
		expect(declared(root, "--u-display")).toContain("bricolage grotesque");
		expect(declared(root, "--u-body")).toContain("schibsted grotesk");
		expect(declared(root, "--u-data")).toContain("martian mono");
	});
});

describe("tokens.css — dark", () => {
	const media = blockBody("@media (prefers-color-scheme: dark)");
	const attribute = blockBody(':root[data-theme="dark"]');

	test.each(THEMED)("%s is redefined under the OS preference", (token) => {
		expect(declared(media, token)).toBe(DARK[token]);
	});

	test.each(THEMED)("%s is redefined under an explicit data-theme=dark", (token) => {
		expect(declared(attribute, token)).toBe(DARK[token]);
	});
});

describe("tokens.css — the explicit toggle beats the OS preference in BOTH directions", () => {
	const restored = blockBody(':root[data-theme="light"]');

	test.each(THEMED)("%s is restored to its light value under data-theme=light", (token) => {
		expect(declared(restored, token)).toBe(LIGHT[token]);
	});

	test("the light restore is authored AFTER the dark media query, so it wins on order", () => {
		// Equal specificity between `:root[data-theme="light"]` and
		// `@media (…dark) :root[data-theme="light"]`-adjacent rules is broken by
		// source order; authoring the restore first would make "force light" a
		// no-op on a dark-preference machine.
		expect(source.indexOf(':root[data-theme="light"]')).toBeGreaterThan(
			source.indexOf("@media (prefers-color-scheme: dark)"),
		);
	});

	test("color-scheme is pinned per theme so UA surfaces follow the toggle too", () => {
		expect(declared(blockBody(":root {"), "color-scheme")).toBe("light dark");
		expect(declared(blockBody(':root[data-theme="dark"]'), "color-scheme")).toBe("dark");
		expect(declared(blockBody(':root[data-theme="light"]'), "color-scheme")).toBe("light");
	});
});

describe("tokens.css — the quality floor it owns globally (§11)", () => {
	test("focus is a 2px straw outline offset by 2px, on every interactive element", () => {
		expect(source).toMatch(/outline:\s*2px solid var\(--u-straw\)/);
		expect(source).toMatch(/outline-offset:\s*2px/);
		expect(source).toContain(":focus-visible");
	});

	test("decorative motion is suppressed under prefers-reduced-motion", () => {
		expect(source).toContain("@media (prefers-reduced-motion: reduce)");
	});
});
