import { describe, expect, it } from "vitest";
import { MAX_MINOR, toMinor } from "../src/util.js";

describe("toMinor: decimal parsing, never float arithmetic", () => {
	it.each([
		[19.99, "USD", 1999],
		["19.99", "USD", 1999],
		[0.29, "USD", 29], // 0.29 * 100 = 28.999999999999996 in float math
		[1.005, "USD", null], // three decimals in a two-digit currency
		["1.50", "USD", 150],
		["1.500", "USD", 150], // trailing zeros are not extra precision
		[10, "USD", 1000],
		["0", "USD", 0],
		[1200, "JPY", 1200],
		["1200.5", "JPY", null],
		["1.23", "KWD", 1230],
		["1.234", "KWD", null], // Stripe takes three-decimal amounts in multiples of 10
		["500", "UGX", null], // not in full Otta's table: Stripe takes UGX as two-decimal
		["500", "ISK", null],
		["500", "JPY", 500],
		["1.2345", "KWD", null],
	])("%s %s -> %s", (v, cur, want) => {
		expect(toMinor(v, cur)).toBe(want);
	});

	it.each([
		-1,
		"-1",
		"1e3",
		1e21,
		"abc",
		"",
		" ",
		"1.",
		".5",
		"1,00",
		Number.NaN,
		Number.POSITIVE_INFINITY,
		null,
		undefined,
		{},
		true,
	])("rejects %s", (v) => {
		expect(toMinor(v, "USD")).toBeNull();
	});

	it("caps at MAX_MINOR", () => {
		expect(toMinor("999999.99", "USD")).toBe(MAX_MINOR);
		expect(toMinor("1000000", "USD")).toBeNull();
	});
});
