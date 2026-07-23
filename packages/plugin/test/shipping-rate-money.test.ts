import { describe, expect, test } from "vitest";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "../src/admin/money-input.js";

// The SHARED admin money text-input module (`src/admin/money-input.ts`) —
// extracted when the Shipping console (admin-UX Increment 3, slice 3) needed
// a second, near-identical copy of the Products console's price parsing.
// Money is integer minor units (CLAUDE.md: never floats): a Block Kit
// `number_input` would hand back a JS float, so amounts are TEXT inputs
// parsed by EXACT integer string math. The ONE behavioral fork between
// consumers — whether ZERO is a valid amount — is the explicit `allowZero`
// parameter, pinned in both positions here. (The Products screens' own
// `allowZero: false` wrapper is additionally pinned end-to-end by
// `product-edit-money.test.ts`; the Shipping screens use `allowZero: true` —
// a $0 flat rate, or a free-shipping method's below-threshold fallback, are
// both legitimate, matching the service's `nonnegative()` (not `positive()`)
// schemas.)

describe("parseMinorUnitsInput", () => {
	test("parses whole and fractional amounts exactly (no float drift)", () => {
		expect(parseMinorUnitsInput("4.99", { allowZero: true })).toBe(499);
		expect(parseMinorUnitsInput("35", { allowZero: true })).toBe(3500);
		expect(parseMinorUnitsInput("35.00", { allowZero: true })).toBe(3500);
		expect(parseMinorUnitsInput("0.01", { allowZero: true })).toBe(1);
		expect(parseMinorUnitsInput("24.5", { allowZero: true })).toBe(2450); // one decimal ⇒ padded
		expect(parseMinorUnitsInput(" 4.99 ", { allowZero: true })).toBe(499); // trims surrounding space
	});

	test("the zero fork is the explicit parameter: allowed for shipping rates, rejected for prices", () => {
		expect(parseMinorUnitsInput("0", { allowZero: true })).toBe(0);
		expect(parseMinorUnitsInput("0.00", { allowZero: true })).toBe(0);
		expect(parseMinorUnitsInput("0", { allowZero: false })).toBeNull();
		expect(parseMinorUnitsInput("0.00", { allowZero: false })).toBeNull();
		// A positive amount is unaffected by the fork.
		expect(parseMinorUnitsInput("4.99", { allowZero: false })).toBe(499);
	});

	test("rejects malformed / negative input in BOTH positions (never throws)", () => {
		for (const allowZero of [true, false]) {
			expect(parseMinorUnitsInput("4.999", { allowZero })).toBeNull(); // 3 decimals: out of scope
			expect(parseMinorUnitsInput("-5", { allowZero })).toBeNull();
			expect(parseMinorUnitsInput("-0.01", { allowZero })).toBeNull();
			expect(parseMinorUnitsInput("abc", { allowZero })).toBeNull();
			expect(parseMinorUnitsInput("", { allowZero })).toBeNull();
			expect(parseMinorUnitsInput("1.", { allowZero })).toBeNull();
			expect(parseMinorUnitsInput(".5", { allowZero })).toBeNull();
			expect(parseMinorUnitsInput("1,000", { allowZero })).toBeNull();
		}
	});
});

describe("formatMinorUnitsInput", () => {
	test("formats integer minor units to a hundredths decimal string", () => {
		expect(formatMinorUnitsInput(499)).toBe("4.99");
		expect(formatMinorUnitsInput(0)).toBe("0.00");
		expect(formatMinorUnitsInput(3500)).toBe("35.00");
		expect(formatMinorUnitsInput(1)).toBe("0.01");
	});

	test("round-trips with the parser for representative amounts", () => {
		for (const cents of [0, 1, 99, 100, 499, 2450, 3500, 100_000]) {
			expect(parseMinorUnitsInput(formatMinorUnitsInput(cents), { allowZero: true })).toBe(cents);
		}
	});
});
