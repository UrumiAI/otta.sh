import { describe, expect, test } from "vitest";
import { formatCentsInput, parseCentsInput } from "../src/admin/shipping-page.js";

// The money input for the shipping admin drill-down (admin-UX Increment 3,
// slice 3). Shipping rate amounts / free-shipping thresholds are integer
// minor units (CLAUDE.md: money fields are integers, never floats): a Block
// Kit `number_input` would hand back a JS float, so amounts are TEXT inputs
// parsed by EXACT integer string math. UNLIKE `products-page.ts`'s
// `parsePriceMinorUnits`, ZERO is a valid amount here (a $0 flat rate, or a
// free-shipping method's below-threshold fallback) — the service's own
// `shippingRateBody`/`shippingRateUpdateBody` schemas use `nonnegative()`,
// not `positive()`.

describe("parseCentsInput", () => {
	test("parses whole and fractional amounts exactly (no float drift)", () => {
		expect(parseCentsInput("4.99")).toBe(499);
		expect(parseCentsInput("35")).toBe(3500);
		expect(parseCentsInput("35.00")).toBe(3500);
		expect(parseCentsInput("0.01")).toBe(1);
		expect(parseCentsInput("24.5")).toBe(2450); // one decimal ⇒ padded
		expect(parseCentsInput(" 4.99 ")).toBe(499); // trims surrounding space
	});

	test("ZERO is accepted (unlike price parsing) — a $0 flat rate is legitimate", () => {
		expect(parseCentsInput("0")).toBe(0);
		expect(parseCentsInput("0.00")).toBe(0);
	});

	test("rejects malformed / negative input (never throws)", () => {
		expect(parseCentsInput("4.999")).toBeNull(); // 3 decimals: out of scope
		expect(parseCentsInput("-5")).toBeNull();
		expect(parseCentsInput("-0.01")).toBeNull();
		expect(parseCentsInput("abc")).toBeNull();
		expect(parseCentsInput("")).toBeNull();
		expect(parseCentsInput("1.")).toBeNull();
		expect(parseCentsInput(".5")).toBeNull();
		expect(parseCentsInput("1,000")).toBeNull();
	});
});

describe("formatCentsInput", () => {
	test("formats integer minor units to a hundredths decimal string", () => {
		expect(formatCentsInput(499)).toBe("4.99");
		expect(formatCentsInput(0)).toBe("0.00");
		expect(formatCentsInput(3500)).toBe("35.00");
		expect(formatCentsInput(1)).toBe("0.01");
	});

	test("round-trips with the parser for representative amounts", () => {
		for (const cents of [0, 1, 99, 100, 499, 2450, 3500, 100_000]) {
			expect(parseCentsInput(formatCentsInput(cents))).toBe(cents);
		}
	});
});
