import { describe, expect, test } from "vitest";
import { isIsoCurrencyCode } from "../src/admin/currency-codes.js";

describe("isIsoCurrencyCode — membership, not just shape", () => {
	test("accepts the currencies a store actually prices in", () => {
		for (const code of ["USD", "EUR", "GBP", "JPY", "INR", "CHF", "KWD"]) {
			expect(isIsoCurrencyCode(code), code).toBe(true);
		}
	});

	test("refuses three letters that are not a currency, and anything not upper-case alpha-3", () => {
		for (const code of ["XYZ", "AAA", "usd", "US", "USDD", "", "12$"]) {
			expect(isIsoCurrencyCode(code), code).toBe(false);
		}
	});
});
