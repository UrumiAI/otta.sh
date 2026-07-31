import { allocateCents, cents } from "@otta-sh/domain";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

describe("allocateCents", () => {
	test("assigns remainder cents to largest-remainder buckets, ties broken by input order", () => {
		// 100 / 3: each floor(33.33) = 33, leftover 1 cent to the first bucket (tie → index 0).
		expect(allocateCents(cents(100), [1, 1, 1])).toEqual([34, 33, 33]);
		// Weighted: 10 across weights [1,3] → floor 2.5→2, 7.5→7, leftover 1 → larger frac (0.5 vs 0.5 tie → index 0).
		expect(allocateCents(cents(10), [1, 3])).toEqual([3, 7]);
		// Zero total is all zeros.
		expect(allocateCents(cents(0), [5, 3, 2])).toEqual([0, 0, 0]);
		// All-zero weights ⇒ equal split, round-robin by index.
		expect(allocateCents(cents(5), [0, 0])).toEqual([3, 2]);
	});

	test("sum of allocated buckets equals total, for arbitrary total and weights (property)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000_00 }),
				fc.array(fc.integer({ min: 0, max: 50_000_00 }), { minLength: 1, maxLength: 20 }),
				(total, weights) => {
					const out = allocateCents(cents(total), weights);
					expect(out).toHaveLength(weights.length);
					// Exact reconciliation — the whole point.
					expect(out.reduce((a, b) => a + b, 0)).toBe(total);
					// Every share is a non-negative safe integer.
					for (const c of out) {
						expect(Number.isSafeInteger(c)).toBe(true);
						expect(c).toBeGreaterThanOrEqual(0);
					}
				},
			),
			{ numRuns: 2000 },
		);
	});

	test("large carts do not lose precision: total×weight exceeds 2^53 yet Σ === total (property)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000_00 }),
				fc.array(fc.integer({ min: 1, max: 50_000_00 }), { minLength: 2, maxLength: 20 }),
				(total, weights) => {
					const out = allocateCents(cents(total), weights);
					expect(out.reduce((a, b) => a + b, 0)).toBe(total);
				},
			),
			{ numRuns: 2000 },
		);
	});
});
