import { describe, expect, test } from "vitest";
import { parseProductTitle } from "../src/sync/parse-product-title.js";

/**
 * A dedicated unit test for the title validator, added when it moved out of the
 * deleted `product-commerce/parse-commerce-fields.ts` into `sync/` (PR 1b, "one
 * home per field"). It previously had no direct coverage — only the sandbox
 * hook tests exercised it, and only through workerd.
 *
 * It earns the test now because it is PERMANENT and load-bearing: the title is
 * the ONLY field the CMS sync still projects into `product_commerce`, and the
 * value an order line snapshots at purchase time. Its two rules are:
 *
 *  - never send an unusable value (`""` and >500 chars are both 400s at the
 *    service, and a 400 is a TRANSPORT failure, which at `content:afterPublish`
 *    fails closed and skips the activate — a content problem must never
 *    masquerade as a transport problem);
 *  - never reject the whole sync: an unusable title yields a `problem` the
 *    caller LOGS, and the row is still upserted.
 */
describe("parseProductTitle", () => {
	test("a normal title passes through", () => {
		expect(parseProductTitle("Blue Mug")).toEqual({ title: "Blue Mug" });
	});

	test("the value is TRIMMED — the stored cache never carries editor whitespace", () => {
		expect(parseProductTitle("  Blue Mug  ")).toEqual({ title: "Blue Mug" });
		expect(parseProductTitle("\tBlue Mug\n")).toEqual({ title: "Blue Mug" });
	});

	test("ABSENT (undefined) — em-dash's mapRow drops null columns, so a null title arrives as a missing key", () => {
		const result = parseProductTitle(undefined);
		expect(result).not.toHaveProperty("title");
		expect((result as { problem: string }).problem).toContain("no `title` field");
	});

	test("an explicit null is the same non-fatal case", () => {
		const result = parseProductTitle(null);
		expect(result).not.toHaveProperty("title");
		expect((result as { problem: string }).problem).toContain("no `title` field");
	});

	test("a NON-STRING title (a collection that declares `title` as a number/bool/object) reports the type", () => {
		for (const [value, typeName] of [
			[42, "number"],
			[true, "boolean"],
			[{ en: "Blue Mug" }, "object"],
		] as const) {
			const result = parseProductTitle(value);
			expect(result).not.toHaveProperty("title");
			expect((result as { problem: string }).problem).toBe(
				`\`data.title\` is ${typeName}, not a string`,
			);
		}
	});

	test('EMPTY and whitespace-only are rejected — the service 400s on `""`', () => {
		for (const value of ["", "   ", "\t\n "]) {
			const result = parseProductTitle(value);
			expect(result).not.toHaveProperty("title");
			expect((result as { problem: string }).problem).toBe("`data.title` is empty/whitespace");
		}
	});

	test("500 characters is ACCEPTED and 501 is not — the bound mirrors the service's z.string().max(500)", () => {
		expect(parseProductTitle("T".repeat(500))).toEqual({ title: "T".repeat(500) });
		const over = parseProductTitle("T".repeat(501));
		expect(over).not.toHaveProperty("title");
		expect((over as { problem: string }).problem).toContain("501 characters");
		expect((over as { problem: string }).problem).toContain("at most 500");
	});

	test("the length bound is applied AFTER trimming — 500 chars inside padding still passes", () => {
		expect(parseProductTitle(`  ${"T".repeat(500)}  `)).toEqual({ title: "T".repeat(500) });
	});
});
