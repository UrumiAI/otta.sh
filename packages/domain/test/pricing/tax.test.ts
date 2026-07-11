import { cents, computeLineTax, divRoundHalfUp } from "@urumi/domain";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

describe("computeLineTax", () => {
	test("known example — 999 cents at 725bps rounds half-up to 72", () => {
		// 999 × 725 / 10000 = 72.4275 → 72.
		expect(computeLineTax(cents(999), 725)).toBe(72);
		// A half case rounds up: 200 × 750 / 10000 = 15.0 (exact) — pick a true half:
		// 100 × 550 / 10000 = 5.5 → 6 (half-up, not banker's 6 either; 4.5→5 proves away-from-even).
		expect(computeLineTax(cents(100), 550)).toBe(6);
		expect(computeLineTax(cents(100), 450)).toBe(5); // 4.5 → 5 (away-from-zero, not banker's 4)
	});

	test("zero amount or zero rate yields zero; result is a non-negative safe integer (property)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000_00 }),
				fc.integer({ min: 0, max: 10_000 }),
				(amount, rateBps) => {
					const tax = computeLineTax(cents(amount), rateBps);
					expect(Number.isSafeInteger(tax)).toBe(true);
					expect(tax).toBeGreaterThanOrEqual(0);
					if (amount === 0 || rateBps === 0) expect(tax).toBe(0);
					// Tax never exceeds the taxed amount for rates ≤ 100%.
					expect(tax).toBeLessThanOrEqual(amount);
				},
			),
			{ numRuns: 2000 },
		);
	});

	test("divRoundHalfUp is exact half-up for non-negative integers", () => {
		expect(divRoundHalfUp(5, 10_000)).toBe(0); // 0.0005 → 0
		expect(divRoundHalfUp(5000, 10_000)).toBe(1); // 0.5 → 1
		expect(divRoundHalfUp(4999, 10_000)).toBe(0); // 0.4999 → 0
	});
});
