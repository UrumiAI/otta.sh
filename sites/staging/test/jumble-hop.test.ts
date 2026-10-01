/**
 * Jumble's hop to the bag (theme-briefs.md §4, "Signature: hop to the bag"):
 * on the bag page, on add, the NEWEST live hold sends one copy of its picture
 * up to the header bag — one flying element per view, decoration only, CSS
 * only. The patterns below match tokens, not the formatter's whitespace.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { hopLineId } from "../src/themes/jumble/hop.js";
import { SRC } from "./theme-views.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe("hopLineId", () => {
	test("the line whose hold runs out last — the one just put in the bag", () => {
		const lines = [
			{ lineId: "a", expiresAt: at(3) },
			{ lineId: "b", expiresAt: at(14) },
			{ lineId: "c", expiresAt: at(9) },
		];
		expect(hopLineId(lines, NOW)).toBe("b");
	});

	test("a tie goes to the later line", () => {
		const lines = [
			{ lineId: "a", expiresAt: at(10) },
			{ lineId: "b", expiresAt: at(10) },
		];
		expect(hopLineId(lines, NOW)).toBe("b");
	});

	test("no reservation and a released hold never hop", () => {
		expect(hopLineId([{ lineId: "a", expiresAt: null }], NOW)).toBeNull();
		expect(hopLineId([{ lineId: "a", expiresAt: at(-1) }], NOW)).toBeNull();
		expect(hopLineId([{ lineId: "a", expiresAt: "not a date" }], NOW)).toBeNull();
		expect(
			hopLineId(
				[
					{ lineId: "a", expiresAt: at(-1) },
					{ lineId: "b", expiresAt: at(2) },
				],
				NOW,
			),
		).toBe("b");
		expect(hopLineId([], NOW)).toBeNull();
	});
});

describe("the hop's markup and motion", () => {
	const view = readFileSync(path.join(SRC, "themes/jumble/CartView.astro"), "utf8");
	const template = view
		.slice(view.indexOf("\n---", 3) + 4)
		.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
	const sheet = readFileSync(path.join(SRC, "themes/jumble/commerce.css"), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);

	test("ONE flying element per view, hidden from assistive tech, on the live arm only", () => {
		expect(template.match(/class="j-hop"/g)).toHaveLength(1);
		const [hopTag = ""] = /<div\s[^>]*class="j-hop"[^>]*>/.exec(template) ?? [];
		expect(hopTag).toMatch(/\saria-hidden="true"/);
		// Drawn only when a line hops, and after the live arm opens.
		expect(template).toMatch(/\{\s*hopView\s*!==\s*null\s*&&\s*\(\s*<div\s[^>]*class="j-hop"/);
		expect(template.indexOf('class="j-hop"')).toBeGreaterThan(template.indexOf('class="j-cart"'));
		// Its launch point is the SAME line it copies.
		expect(template).toMatch(
			/data-hop=\{\s*view\.line\.lineId\s*===\s*hopId\s*\?\s*""\s*:\s*undefined\s*\}/,
		);
		// A decoration's copy of a picture already on the page: not eager.
		const [copy = ""] = /<div class="j-hop-toy">\s*<Field\b[^>]*>/.exec(template) ?? [];
		expect(copy).not.toBe("");
		expect(copy).not.toMatch(/\beager\b/);
	});

	test("it hops ON ADD only: the newest hold, and only when it was just taken", () => {
		const frontmatter = view.slice(0, view.indexOf("\n---", 3));
		expect(frontmatter).toMatch(
			/import\s*\{\s*isFreshHold\s*\}\s*from\s*"\.\.\/\.\.\/lib\/hold\.js"/,
		);
		expect(frontmatter).toMatch(
			/const hopView\s*=\s*newest\s*!==\s*null\s*&&\s*isFreshHold\(\s*newest\.line\.expiresAt,\s*now\s*\)\s*\?\s*newest\s*:\s*null/,
		);
		// One clock for both reads.
		expect(frontmatter).toMatch(/const now = new Date\(\);/);
		expect(frontmatter).toMatch(/hopLineId\([\s\S]{0,80},\s*now\s*\)/);
		// The badge's pop (and its reduced-motion pulse) key off the copy being
		// in the page, so they are on add only too.
		expect(sheet).toMatch(/body:has\(\.j-hop\)\s+\.j-badge\s*\{\s*animation:\s*j-badge-pop\b/);
	});

	test("it is nothing until the motion block draws it, and it never takes a click", () => {
		// Outside every media block the copy is not drawn at all — so reduced
		// motion, and a browser without anchor positioning, never see it.
		expect(sheet).toMatch(/(^|\n)\s*\.j-hop\s*\{\s*display:\s*none;?\s*\}/);
		// Drawn only when the header has a bag to land in.
		const [, drawn = ""] =
			/body:has\(\.j-bag\)\s+\.j-hop\s*\{\s*display:\s*block;([^}]*)\}/.exec(sheet) ?? [];
		expect(drawn, "no drawn .j-hop rule").not.toBe("");
		expect(drawn).toMatch(/position:\s*fixed\b/);
		expect(drawn).toMatch(/pointer-events:\s*none\b/);
		// The brief's arc: x linear, y on the wind-up curve, 560ms each.
		expect(drawn).toMatch(/j-hop-x\s+560ms\s+linear\b/);
		expect(drawn).toMatch(
			/j-hop-y\s+560ms\s+cubic-bezier\(\s*0\.3\s*,\s*-0\.5\s*,\s*0\.7\s*,\s*1\s*\)/,
		);
		// It lands transparent and stays so: nothing covers the page afterwards.
		const start = sheet.indexOf("@keyframes j-hop-shrink");
		const shrink = sheet.slice(start, sheet.indexOf("@keyframes", start + 1));
		expect(shrink).toMatch(/100%\s*\{\s*opacity:\s*0;/);
		expect(sheet).toMatch(/j-hop-shrink\s+560ms\s+linear\s+\d+ms\s+both\b/);
	});

	test("the bag squashes 1.15 → .94 → 1 in 260ms on the overshoot curve", () => {
		expect(sheet).toMatch(/j-bag-squash\s+260ms\s+var\(\s*--j-ease-toy\s*\)/);
		expect(sheet).toMatch(/35%\s*\{\s*scale:\s*1\.15;?\s*\}\s*70%\s*\{\s*scale:\s*0\.94;?\s*\}/);
	});
});
