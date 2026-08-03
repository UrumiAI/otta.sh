import { describe, expect, test } from "vitest";
import { formatMinorUnitsInput } from "../src/admin/money-input.js";
import { parsePriceMinorUnits } from "../src/admin/products-actions.js";

// The money input for the Pricing & inventory price edit. Money is integer minor
// units, NEVER a float (CLAUDE.md): a `number_input` would hand back a JS float,
// so price is a TEXT field parsed by EXACT integer string math. These pin that
// the parse/format round-trips and that no float-arithmetic footguns leak in
// (`parseFloat("19.99")*100` yields 1998.9999… — this parser must yield exactly
// 1999).
//
// THE FORMAT HALF NAMES `formatMinorUnitsInput` DIRECTLY now (INC-R3). The
// retired Block Kit screen exported it under the alias `formatPriceMinorUnits`
// for its own text inputs' `initial_value`; the React screen calls the shared
// `@otta-sh/admin-presentation` formatter, so with that screen gone the alias had
// no caller. Deleting an alias is not deleting an assertion — every case below is
// the one it always was, against the function the alias forwarded to.

describe("parsePriceMinorUnits", () => {
	test("parses hundredths exactly (no float drift)", () => {
		expect(parsePriceMinorUnits("19.99")).toBe(1999);
		expect(parsePriceMinorUnits("0.01")).toBe(1);
		expect(parsePriceMinorUnits("100")).toBe(10000); // whole units ⇒ ×100
		expect(parsePriceMinorUnits("24.5")).toBe(2450); // one decimal ⇒ padded
		expect(parsePriceMinorUnits(" 7.00 ")).toBe(700); // trims surrounding space
	});

	test("rejects a non-positive price (the domain's price > 0 rule)", () => {
		expect(parsePriceMinorUnits("0")).toBeNull();
		expect(parsePriceMinorUnits("0.00")).toBeNull();
	});

	test("rejects malformed / over-precise / non-numeric input (never throws)", () => {
		expect(parsePriceMinorUnits("19.999")).toBeNull(); // 3 decimals out of scope
		expect(parsePriceMinorUnits("-5.00")).toBeNull();
		expect(parsePriceMinorUnits("1,999")).toBeNull();
		expect(parsePriceMinorUnits("abc")).toBeNull();
		expect(parsePriceMinorUnits("")).toBeNull();
		expect(parsePriceMinorUnits("1.")).toBeNull();
		expect(parsePriceMinorUnits(".5")).toBeNull();
	});
});

describe("formatMinorUnitsInput", () => {
	test("formats minor units to a hundredths decimal string", () => {
		expect(formatMinorUnitsInput(1999)).toBe("19.99");
		expect(formatMinorUnitsInput(1)).toBe("0.01");
		expect(formatMinorUnitsInput(2450)).toBe("24.50");
		expect(formatMinorUnitsInput(10000)).toBe("100.00");
	});

	test("round-trips with the parser for representative amounts", () => {
		for (const units of [1, 99, 100, 1999, 2450, 10000, 999999]) {
			expect(parsePriceMinorUnits(formatMinorUnitsInput(units))).toBe(units);
		}
	});
});
