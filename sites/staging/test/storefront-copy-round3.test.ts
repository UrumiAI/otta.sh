/**
 * Storefront copy that said something untrue or unhelpful (QA round 2, minor):
 * each pin here is the sentence the shopper now reads, or the rule behind it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { templateOf } from "./astro-source.js";
import { SRC, viewCases } from "./theme-views.js";

describe("the coupon note tells the truth about case (ADR-0025)", () => {
	test.each(viewCases("checkout"))("%s never says codes are case-sensitive", (_l, { source }) => {
		const template = templateOf(source);
		expect(template).not.toMatch(/Codes are case-sensitive/);
		expect(template).toContain("Codes aren't case-sensitive.");
	});
});

describe("the home page never states a catalog size it does not know (QA2 A9)", () => {
	test("the seeded tagline carries no count — the shop grows, the tagline would not", () => {
		const seed = JSON.parse(readFileSync(path.join(SRC, "../seed/seed.json"), "utf8")) as {
			settings: { tagline: string };
		};
		expect(seed.settings.tagline).not.toMatch(
			/\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|whole shop)\b/i,
		);
	});
});
