import { describe, expect, test } from "vitest";
import { formatBpsAsPercent, parsePercentToBps } from "../src/admin/percent-input.js";

// The percent input for the tax admin drill-down (admin-UX Increment 3, slice
// 2), now the SHARED `percent-input.ts` module (extracted when the Coupons
// console became the second consumer — slice 4). `rate_bps` is integer basis
// points (CLAUDE.md: money/rate fields are integers, never floats): a Block
// Kit `number_input` would hand back a JS float, so the rate is a TEXT input
// parsed by EXACT integer string math. These pin the exact round-trips called
// out in the slice's brief and are the extraction's byte-identical spec.

describe("parsePercentToBps", () => {
	test("parses the brief's exact examples", () => {
		expect(parsePercentToBps("7.25")).toBe(725);
		expect(parsePercentToBps("0")).toBe(0);
		expect(parsePercentToBps("100")).toBe(10000);
	});

	test("parses hundredths exactly (no float drift)", () => {
		expect(parsePercentToBps("0.01")).toBe(1);
		expect(parsePercentToBps("1000")).toBe(100_000); // the domain's own max
		expect(parsePercentToBps("24.5")).toBe(2450); // one decimal ⇒ padded
		expect(parsePercentToBps(" 7.00 ")).toBe(700); // trims surrounding space
	});

	test("rejects malformed / out-of-range input (never throws)", () => {
		expect(parsePercentToBps("7.255")).toBeNull(); // 3 decimals: out of scope
		expect(parsePercentToBps("1000.01")).toBeNull(); // over the domain's max
		expect(parsePercentToBps("-5")).toBeNull();
		expect(parsePercentToBps("abc")).toBeNull();
		expect(parsePercentToBps("")).toBeNull();
		expect(parsePercentToBps("1.")).toBeNull();
		expect(parsePercentToBps(".5")).toBeNull();
		expect(parsePercentToBps("1,000")).toBeNull();
	});
});

describe("formatBpsAsPercent", () => {
	test("formats basis points to a hundredths decimal string", () => {
		expect(formatBpsAsPercent(725)).toBe("7.25");
		expect(formatBpsAsPercent(0)).toBe("0.00");
		expect(formatBpsAsPercent(10_000)).toBe("100.00");
		expect(formatBpsAsPercent(1)).toBe("0.01");
	});

	test("round-trips with the parser for representative amounts", () => {
		for (const bps of [0, 1, 99, 100, 725, 2450, 10_000, 100_000]) {
			expect(parsePercentToBps(formatBpsAsPercent(bps))).toBe(bps);
		}
	});
});
