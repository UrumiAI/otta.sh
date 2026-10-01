/**
 * Batch's one stamp per view (theme-briefs.md §3, "Never: stamp more than one
 * thing per view"): the bag page stamps the NEWEST live hold and nothing else.
 * And the art the stamp's labels sit on, whose body `Art.astro` sets as HTML.
 */
import { describe, expect, test } from "vitest";
import { productArt, stampTilt } from "../src/themes/batch/art.js";
import { stampedLineId } from "../src/themes/batch/stamp.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe("stampedLineId", () => {
	test("the line whose hold runs out last — the one just set aside", () => {
		const lines = [
			{ lineId: "a", expiresAt: at(3) },
			{ lineId: "b", expiresAt: at(14) },
			{ lineId: "c", expiresAt: at(9) },
		];
		expect(stampedLineId(lines, NOW)).toBe("b");
	});

	test("a tie goes to the later line", () => {
		const lines = [
			{ lineId: "a", expiresAt: at(10) },
			{ lineId: "b", expiresAt: at(10) },
		];
		expect(stampedLineId(lines, NOW)).toBe("b");
	});

	test("no reservation and a released hold are never stamped", () => {
		expect(stampedLineId([{ lineId: "a", expiresAt: null }], NOW)).toBeNull();
		expect(stampedLineId([{ lineId: "a", expiresAt: at(-1) }], NOW)).toBeNull();
		expect(
			stampedLineId(
				[
					{ lineId: "a", expiresAt: at(-1) },
					{ lineId: "b", expiresAt: at(2) },
				],
				NOW,
			),
		).toBe("b");
		expect(stampedLineId([], NOW)).toBeNull();
	});

	test("the tilt is seeded, stable, and inside −4°…−1°", () => {
		for (const seed of ["line-1", "line-2", "a-very-long-line-id"]) {
			const tilt = stampTilt(seed);
			expect(tilt).toBe(stampTilt(seed));
			expect(tilt).toBeGreaterThanOrEqual(-4);
			expect(tilt).toBeLessThanOrEqual(-1);
		}
	});
});

describe("productArt — its body is safe to set:html", () => {
	test("no caller-supplied string reaches the body, whatever the title and id", () => {
		// "mug" in the title picks the mug art, which draws no label; the others
		// print the title as a label the template escapes — never into `body`.
		for (const title of ['<img onerror=x> "mug"', '<img onerror=x> "tee"', "<img onerror=x>"]) {
			const art = productArt("s", title, 'a"><x');
			expect(art.body).not.toContain("<img");
			expect(art.body).not.toContain("onerror");
			expect(art.body).not.toContain('"><x');
		}
	});
});
