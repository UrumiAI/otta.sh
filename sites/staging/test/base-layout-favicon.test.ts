/**
 * Base layout favicon (item 4 — no favicon means a 404 on every page load,
 * console noise). Weak-but-cheap source-text pin (mirrors json-ld-xss.test.ts's
 * pattern for asserting something about an .astro file's markup without
 * rendering it) — real confirmation is the Playwright pass (deferred, see
 * the PR).
 *
 * The mark is the coil (docs/theme/TEMPERED.md §5, §11): an Archimedean
 * spiral swept as a ribbon, the same shape language the product art uses.
 * It stays INLINE — a `public/` asset would be a second request and a second
 * place for the mark to rot.
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

describe("Base layout favicon", () => {
	test("declares an inline SVG data-URI favicon link — no public/ asset, no 404", () => {
		expect(source).toMatch(/<link\s+rel="icon"[^>]*>/);
		expect(source).toContain('type="image/svg+xml"');
		expect(source).toContain("data:image/svg+xml,");
	});

	test("the mark is the coil: one closed swept-ribbon path, not the old disc", () => {
		const href = /href="(data:image\/svg\+xml,[^"]+)"/.exec(source)?.[1];
		expect(href, "no favicon data URI in Base.astro").toBeDefined();
		const markup = decodeURIComponent(href as string);
		expect(markup).toContain("<path");
		// A swept ribbon is one closed outline: out along the spiral, back
		// along its inner edge. Straight segments, so plenty of them.
		const d = /\sd='([^']+)'/.exec(markup)?.[1] ?? "";
		expect(d.trimEnd().endsWith("Z"), "the ribbon outline must close").toBe(true);
		expect((d.match(/L/g) ?? []).length).toBeGreaterThan(24);
		// The placeholder mark was a rounded square with a disc punched in it.
		expect(markup).not.toContain("<circle");
	});

	test("every hex it hardcodes is still drawn from tokens.css", () => {
		// A favicon cannot read a custom property, so these literals are the one
		// place in the theme a colour is written down twice, and nothing warns
		// when the palette moves out from under them.
		//
		// SCOPE: a drift alarm, not a design check. It says each hex still
		// exists in the palette. It says NOTHING about the pairing being right —
		// the mark could pick two tokens that are illegible together, or the
		// dark-theme ink on the dark-theme ground, and this would still pass.
		// Judging the mark is the screenshot's job.
		const tokens = readFileSync(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/styles/tokens.css"),
			"utf8",
		).toLowerCase();
		const hexes = [...source.matchAll(/%23([0-9a-fA-F]{6})/g)].map((m) => `#${m[1]}`.toLowerCase());
		expect(hexes.length, "no colours found in the favicon data URI").toBeGreaterThan(0);
		for (const hex of hexes) {
			expect(tokens, `favicon hex ${hex} is no longer in tokens.css`).toContain(hex);
		}
	});
});
