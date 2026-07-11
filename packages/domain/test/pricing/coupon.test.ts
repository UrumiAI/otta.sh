import {
	cents,
	computeCouponDiscount,
	CouponCurrencyMismatchError,
	currency,
	type Coupon,
} from "@urumi/domain";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

const USD = currency("USD");
const EUR = currency("EUR");

describe("computeCouponDiscount", () => {
	test("fixed_amount clamps at subtotal", () => {
		const c: Coupon = {
			type: "fixed_amount",
			code: "SAVE5",
			amountCents: cents(500),
			currency: USD,
		};
		expect(computeCouponDiscount(cents(1299), USD, c)).toBe(500);
		// Clamp: subtotal 300 < 500 ⇒ discount 300, not 500 (never past zero).
		expect(computeCouponDiscount(cents(300), USD, c)).toBe(300);
	});

	test("fixed_amount rejects a currency mismatch", () => {
		const c: Coupon = {
			type: "fixed_amount",
			code: "EURO",
			amountCents: cents(500),
			currency: EUR,
		};
		expect(() => computeCouponDiscount(cents(1000), USD, c)).toThrow(CouponCurrencyMismatchError);
	});

	test("percentage applies bps to subtotal, capped by maxDiscountCents", () => {
		// 10% (1000 bps) of $500.00 = $50.00, capped at $20.00 ⇒ 2000, not 5000.
		const capped: Coupon = { type: "percentage", code: "TEN", bps: 1000, capCents: cents(2000) };
		expect(computeCouponDiscount(cents(500_00), USD, capped)).toBe(2000);
		// Uncapped 10% of $500 = 5000.
		const uncapped: Coupon = { type: "percentage", code: "TEN", bps: 1000, capCents: null };
		expect(computeCouponDiscount(cents(500_00), USD, uncapped)).toBe(5000);
	});

	test("discount is always within [0, subtotal] (property)", () => {
		const couponArb: fc.Arbitrary<Coupon> = fc.oneof(
			fc.record({
				type: fc.constant("fixed_amount" as const),
				code: fc.constant("F"),
				amountCents: fc.integer({ min: 0, max: 100_000_00 }).map((n) => cents(n)),
				currency: fc.constant(USD),
			}),
			fc.record({
				type: fc.constant("percentage" as const),
				code: fc.constant("P"),
				bps: fc.integer({ min: 0, max: 10_000 }),
				capCents: fc.option(
					fc.integer({ min: 0, max: 100_000_00 }).map((n) => cents(n)),
					{
						nil: null,
					},
				),
			}),
		);
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 100_000_00 }), couponArb, (subtotal, coupon) => {
				const d = computeCouponDiscount(cents(subtotal), USD, coupon);
				expect(Number.isSafeInteger(d)).toBe(true);
				expect(d).toBeGreaterThanOrEqual(0);
				expect(d).toBeLessThanOrEqual(subtotal);
			}),
			{ numRuns: 2000 },
		);
	});
});
