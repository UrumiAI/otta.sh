/**
 * Storefront copy that said something untrue or unhelpful (QA round 2, minor):
 * each pin here is the sentence the shopper now reads, or the rule behind it.
 */
import { describe, expect, test } from "vitest";
import { templateOf } from "./astro-source.js";
import { viewCases } from "./theme-views.js";

describe("the coupon note tells the truth about case (ADR-0025)", () => {
	test.each(viewCases("checkout"))("%s never says codes are case-sensitive", (_l, { source }) => {
		const template = templateOf(source);
		expect(template).not.toMatch(/Codes are case-sensitive/);
		expect(template).toContain("Codes aren't case-sensitive.");
	});
});
