import { describe, expect, test } from "vitest";
import { parseVariantName, parseVariantRepeater } from "../src/sync/variants.js";

/**
 * Review R3-B X1 at the CMS sync. A variant's NAME is display text the CMS already
 * holds, so a lone surrogate or NUL in it is repaired to U+FFFD. Its KEY is an
 * identifier — a repaired key would be a different variant — so a row whose key
 * holds one declares nothing, and says why, while every other row still syncs.
 */
describe("variant sync — text that is not well formed", () => {
	test("a name is repaired, never refused", () => {
		expect(parseVariantName("Large\uD800")).toEqual({ title: "Large\uFFFD" });
		expect(parseVariantName("La\u0000rge")).toEqual({ title: "La\uFFFDrge" });
		expect(parseVariantName("Large \uD83D\uDE00")).toEqual({ title: "Large \uD83D\uDE00" });
	});

	test("a key is refused for its row only", () => {
		const parsed = parseVariantRepeater([
			{ key: "small", name: "Small" },
			{ key: "lar\uDC00ge", name: "Large" },
			{ key: "x\u0000", name: "X" },
			{ key: "medium", name: "Medium\uD800" },
		]);
		expect(parsed.declared).toEqual([
			{ variantKey: "small", title: "Small" },
			{ variantKey: "medium", title: "Medium\uFFFD" },
		]);
		expect(parsed.problems).toHaveLength(2);
		for (const problem of parsed.problems) expect(problem).toMatch(/broken character/);
	});
});
