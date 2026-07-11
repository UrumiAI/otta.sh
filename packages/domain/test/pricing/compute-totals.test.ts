import {
	cents,
	computeTotals,
	currency,
	type Coupon,
	type RulesSnapshot,
	type TotalsInput,
	type TotalsLineInput,
} from "@urumi/domain";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

const USD = currency("USD");

const TAX_CLASSES = ["standard", "reduced", "zero", "digital"] as const;

function rules(overrides: Partial<RulesSnapshot> = {}): RulesSnapshot {
	return {
		shippingMethod: {
			zoneId: "z1",
			methodId: "m-flat",
			type: "flat_rate",
			amountCents: cents(0),
			minSubtotalCents: null,
		},
		taxRatesByClass: {},
		shippingTaxable: false,
		shippingTaxClassId: "standard",
		...overrides,
	};
}

describe("computeTotals — golden cases", () => {
	test("case 1: no coupon, no tax, flat shipping ⇒ total == subtotal + shipping", () => {
		const input: TotalsInput = {
			currency: USD,
			lines: [{ unitPriceCents: cents(1000), qty: 2, taxClassId: "standard" }],
			rules: rules({
				shippingMethod: {
					zoneId: "z1",
					methodId: "m-flat",
					type: "flat_rate",
					amountCents: cents(599),
					minSubtotalCents: null,
				},
			}),
		};
		const b = computeTotals(input);
		expect(b.subtotalCents).toBe(2000);
		expect(b.discountCents).toBe(0);
		expect(b.shippingCents).toBe(599);
		expect(b.taxCents).toBe(0);
		expect(b.totalCents).toBe(2599);
		expect(b.appliedCouponCode).toBeUndefined();
	});

	test("case 4: standard 7.25% tax on the discounted line amount, rounded half-up per line", () => {
		// One line $9.99 × 1 = 999; 7.25% = 725 bps ⇒ 72 (999×725/10000 = 72.4275).
		const input: TotalsInput = {
			currency: USD,
			lines: [{ unitPriceCents: cents(999), qty: 1, taxClassId: "standard" }],
			rules: rules({ taxRatesByClass: { standard: 725 } }),
		};
		const b = computeTotals(input);
		expect(b.subtotalCents).toBe(999);
		expect(b.taxCents).toBe(72);
		expect(b.totalCents).toBe(999 + 72);
	});

	test("case 3 + mixed tax classes: percentage coupon pro-rated across a zero-rated and a standard-rated line", () => {
		// $100 standard + $100 zero-rated, 10% cart coupon ($20 off), standard 10% tax.
		// Discount 2000 pro-rated 1000/1000 → each line discounted to 9000.
		// Tax: standard line 9000 × 1000bps = 900; zero line 0. Shipping flat 0.
		const input: TotalsInput = {
			currency: USD,
			lines: [
				{ unitPriceCents: cents(100_00), qty: 1, taxClassId: "standard" },
				{ unitPriceCents: cents(100_00), qty: 1, taxClassId: "zero" },
			],
			coupon: { type: "percentage", code: "TEN", bps: 1000, capCents: null },
			rules: rules({ taxRatesByClass: { standard: 1000, zero: 0 } }),
		};
		const b = computeTotals(input);
		expect(b.subtotalCents).toBe(200_00);
		expect(b.discountCents).toBe(20_00);
		expect(b.lineBreakdown.map((l) => l.discountedCents)).toEqual([90_00, 90_00]);
		expect(b.lineBreakdown.map((l) => l.taxCents)).toEqual([900, 0]);
		expect(b.taxCents).toBe(900);
		expect(b.totalCents).toBe(180_00 + 900);
		expect(b.appliedCouponCode).toBe("TEN");
	});

	test("case 5: taxable shipping adds a shipping-tax line using the zone's shipping tax class", () => {
		const input: TotalsInput = {
			currency: USD,
			lines: [{ unitPriceCents: cents(1000), qty: 1, taxClassId: "zero" }],
			rules: rules({
				shippingMethod: {
					zoneId: "z1",
					methodId: "m-flat",
					type: "flat_rate",
					amountCents: cents(1000),
					minSubtotalCents: null,
				},
				taxRatesByClass: { zero: 0, standard: 1000 },
				shippingTaxable: true,
				shippingTaxClassId: "standard",
			}),
		};
		const b = computeTotals(input);
		expect(b.shippingCents).toBe(1000);
		expect(b.shippingTaxCents).toBe(100); // 1000 × 1000bps
		expect(b.taxCents).toBe(100); // line tax 0 + shipping tax 100
		expect(b.totalCents).toBe(1000 + 1000 + 100);
	});
});

// -- Property tests (the headline: deterministic, no float drift) -------------

function arbInput(): fc.Arbitrary<TotalsInput> {
	const lineArb: fc.Arbitrary<TotalsLineInput> = fc.record({
		unitPriceCents: fc.integer({ min: 0, max: 100_000_00 }).map((n) => cents(n)),
		qty: fc.integer({ min: 1, max: 20 }),
		taxClassId: fc.constantFrom(...TAX_CLASSES),
	});
	const couponArb: fc.Arbitrary<Coupon | undefined> = fc.option(
		fc.oneof(
			fc.record({
				type: fc.constant("fixed_amount" as const),
				code: fc.constant("FIXED"),
				amountCents: fc.integer({ min: 0, max: 100_000_00 }).map((n) => cents(n)),
				currency: fc.constant(USD),
			}),
			fc.record({
				type: fc.constant("percentage" as const),
				code: fc.constant("PCT"),
				bps: fc.integer({ min: 0, max: 10_000 }),
				capCents: fc.option(
					fc.integer({ min: 0, max: 100_000_00 }).map((n) => cents(n)),
					{
						nil: null,
					},
				),
			}),
		),
		{ nil: undefined },
	);
	const rulesArb: fc.Arbitrary<RulesSnapshot> = fc.record({
		shippingMethod: fc.record({
			zoneId: fc.constant("z1"),
			methodId: fc.constant("m"),
			type: fc.constantFrom("flat_rate" as const, "free_shipping" as const),
			amountCents: fc.integer({ min: 0, max: 50_000_00 }).map((n) => cents(n)),
			minSubtotalCents: fc.option(
				fc.integer({ min: 0, max: 100_000_00 }).map((n) => cents(n)),
				{
					nil: null,
				},
			),
		}),
		taxRatesByClass: fc.record({
			standard: fc.integer({ min: 0, max: 10_000 }),
			reduced: fc.integer({ min: 0, max: 10_000 }),
			zero: fc.constant(0),
			digital: fc.integer({ min: 0, max: 10_000 }),
		}),
		shippingTaxable: fc.boolean(),
		shippingTaxClassId: fc.constantFrom(...TAX_CLASSES),
	});
	return fc.record({
		currency: fc.constant(USD),
		lines: fc.array(lineArb, { minLength: 1, maxLength: 20 }),
		coupon: couponArb,
		rules: rulesArb,
	});
}

describe("computeTotals — properties", () => {
	test("sum-of-parts identity holds for arbitrary carts, coupons, shipping, tax rates", () => {
		fc.assert(
			fc.property(arbInput(), (input) => {
				const b = computeTotals(input);
				// Checked against the RETURNED fields — the identity is by construction.
				expect(b.subtotalCents - b.discountCents + b.shippingCents + b.taxCents).toBe(b.totalCents);
				// Discount pro-ration reconciles exactly to the discounted subtotal.
				const discounted = b.lineBreakdown.reduce((a, l) => a + l.discountedCents, 0);
				expect(discounted).toBe(b.subtotalCents - b.discountCents);
				// Per-line tax + shipping tax === tax total.
				const lineTax = b.lineBreakdown.reduce((a, l) => a + l.taxCents, 0);
				expect(lineTax + b.shippingTaxCents).toBe(b.taxCents);
			}),
			{ numRuns: 5000 },
		);
	});

	test("all breakdown fields are non-negative safe integers, and discount ∈ [0, subtotal]", () => {
		fc.assert(
			fc.property(arbInput(), (input) => {
				const b = computeTotals(input);
				for (const v of [
					b.subtotalCents,
					b.discountCents,
					b.shippingCents,
					b.taxCents,
					b.totalCents,
					b.shippingTaxCents,
				]) {
					expect(Number.isSafeInteger(v)).toBe(true);
					expect(v).toBeGreaterThanOrEqual(0);
				}
				expect(b.discountCents).toBeLessThanOrEqual(b.subtotalCents);
			}),
			{ numRuns: 5000 },
		);
	});

	test("calling twice on the same input is bit-identical (determinism — no clock/random in money math)", () => {
		fc.assert(
			fc.property(arbInput(), (input) => {
				expect(computeTotals(input)).toEqual(computeTotals(input));
			}),
			{ numRuns: 2000 },
		);
	});

	test("currency consistency: the breakdown currency equals the single input currency", () => {
		fc.assert(
			fc.property(arbInput(), (input) => {
				expect(computeTotals(input).currency).toBe(input.currency);
			}),
			{ numRuns: 500 },
		);
	});
});
