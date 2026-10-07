import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type Cents, cents, currency } from "../../src/money/cents.js";
import type { TaxRate } from "../../src/ports/tax-rules-store.js";
import { allocateCents } from "../../src/pricing/allocate.js";
import {
	assembleTotals,
	computePreTax,
	computeTotals,
	taxRequestLinesOf,
} from "../../src/pricing/compute-totals.js";
import { computeCouponDiscount } from "../../src/pricing/coupon.js";
import { applyRateTable, rateTableOf } from "../../src/pricing/rate-table-calculator.js";
import { resolveShippingRate } from "../../src/pricing/shipping.js";
import { computeLineTax } from "../../src/pricing/tax.js";
import type { TaxRequest } from "../../src/pricing/tax-calculator.js";
import type { TotalsBreakdown, TotalsInput, TotalsLineBreakdown } from "../../src/pricing/types.js";

/**
 * PR 1's parity proof: the calculator split (pre-tax → rate table → assemble)
 * is BIT-IDENTICAL to the arithmetic main shipped. The oracle below is a frozen
 * copy of `computeTotals` and of `computeQuote`'s rate-map loop as they stood on
 * main (80db9beb) — never edit it to make a change pass.
 */
function legacyComputeTotals(input: TotalsInput): TotalsBreakdown {
	const { currency: cur, lines, coupon, rules } = input;
	const lineSubtotals = lines.map((l) => l.unitPriceCents * l.qty);
	const subtotal = cents(lineSubtotals.reduce((a, b) => a + b, 0));
	const discount = coupon === undefined ? cents(0) : computeCouponDiscount(subtotal, cur, coupon);
	const discountedTotal = cents(subtotal - discount);
	const discountedLines = allocateCents(discountedTotal, lineSubtotals);
	const shipping = resolveShippingRate(rules.shippingMethod, discountedTotal);
	let perLineTax = 0;
	const lineBreakdown: TotalsLineBreakdown[] = lines.map((l, i) => {
		const rateBps = rules.taxRatesByClass[l.taxClassId] ?? 0;
		const discountedCents = discountedLines[i] as Cents;
		const taxCents = computeLineTax(discountedCents, rateBps);
		perLineTax += taxCents;
		return { taxClassId: l.taxClassId, discountedCents, taxCents };
	});
	const shippingTax = rules.shippingTaxable
		? computeLineTax(shipping, rules.taxRatesByClass[rules.shippingTaxClassId] ?? 0)
		: cents(0);
	const tax = cents(perLineTax + shippingTax);
	const breakdown: TotalsBreakdown = {
		currency: cur,
		subtotalCents: subtotal,
		discountCents: discount,
		shippingCents: shipping,
		taxCents: tax,
		totalCents: cents(discountedTotal + shipping + tax),
		lineBreakdown,
		shippingTaxCents: shippingTax,
	};
	if (coupon !== undefined && discount > 0) breakdown.appliedCouponCode = coupon.code;
	return breakdown;
}

/** main's quote.ts:143-155 loop, frozen. */
function legacyRateMap(zoneRates: readonly TaxRate[]) {
	const taxRatesByClass: Record<string, number> = {};
	let shippingTaxable = false;
	let shippingTaxClassId = "standard";
	for (const r of zoneRates) {
		taxRatesByClass[r.taxClassId] = r.rateBps;
		if (r.appliesToShipping) {
			shippingTaxable = true;
			shippingTaxClassId = r.taxClassId;
		}
	}
	return { taxRatesByClass, shippingTaxable, shippingTaxClassId };
}

const USD = currency("USD");
const CLASSES = ["standard", "reduced", "zero", "digital"] as const;

const lineArb = fc.record({
	unitPriceCents: fc.integer({ min: 0, max: 2_000_000 }).map(cents),
	qty: fc.integer({ min: 1, max: 25 }),
	taxClassId: fc.constantFrom(...CLASSES, "unrated"),
});
const zoneRateArb = fc.record({
	taxClassId: fc.constantFrom(...CLASSES),
	rateBps: fc.integer({ min: 0, max: 10_000 }),
	appliesToShipping: fc.boolean(),
});
const couponArb = fc.option(
	fc.oneof(
		fc.record({
			type: fc.constant("percentage" as const),
			code: fc.constant("PCT"),
			bps: fc.integer({ min: 0, max: 10_000 }),
			capCents: fc.option(fc.integer({ min: 0, max: 500_000 }).map(cents), { nil: null }),
		}),
		fc.record({
			type: fc.constant("fixed_amount" as const),
			code: fc.constant("FIX"),
			amountCents: fc.integer({ min: 0, max: 5_000_000 }).map(cents),
			currency: fc.constant(USD),
		}),
	),
	{ nil: undefined },
);
const methodArb = fc.record({
	zoneId: fc.constant("z"),
	methodId: fc.constantFrom("", "m-1"),
	type: fc.constantFrom("flat_rate" as const, "free_shipping" as const),
	amountCents: fc.integer({ min: 0, max: 50_000 }).map(cents),
	minSubtotalCents: fc.option(fc.integer({ min: 0, max: 1_000_000 }).map(cents), { nil: null }),
});

const cartArb = fc.record({
	lines: fc.array(lineArb, { minLength: 1, maxLength: 6 }),
	zoneRates: fc.array(zoneRateArb, { maxLength: 6 }),
	coupon: couponArb,
	shippingMethod: methodArb,
});

describe("rate-table parity with main's arithmetic (property)", () => {
	test("pre-tax → rate table → assemble equals the frozen computeTotals, field for field", () => {
		fc.assert(
			fc.property(cartArb, ({ lines, zoneRates, coupon, shippingMethod }) => {
				const rates = zoneRates.map((r, i) => ({ ...r, id: `r${i}`, zoneId: "z" }));
				const rules = { shippingMethod, ...legacyRateMap(rates) };
				const input: TotalsInput = {
					currency: USD,
					lines,
					...(coupon !== undefined ? { coupon } : {}),
					rules,
				};
				const expected = legacyComputeTotals(input);

				// The wrapper existing callers use.
				expect(computeTotals(input)).toEqual(expected);

				// The split computeQuote uses: the request the calculator sees, the
				// built-in's answer over the store's rate list, then assembly.
				const preTax = computePreTax({
					currency: USD,
					lines,
					...(coupon !== undefined ? { coupon } : {}),
					shippingMethod,
				});
				const request: TaxRequest = {
					purpose: "quote",
					currency: USD,
					pricesIncludeTax: false,
					lines: taxRequestLinesOf(preTax),
					shipping: { amountCents: preTax.shippingCents, methodId: shippingMethod.methodId },
					origin: null,
					destination: null,
					zoneId: "z",
				};
				const answer = applyRateTable(request, rateTableOf(rates), new Map());
				expect(assembleTotals(preTax, answer)).toEqual(expected);
			}),
			{ numRuns: 400 },
		);
	});

	test("the golden INR case: 49900 @1800 + 39800 @500 + shipping 4900 @1800 = 11854 tax", () => {
		const rules = {
			shippingMethod: {
				zoneId: "z",
				methodId: "m",
				type: "flat_rate" as const,
				amountCents: cents(4900),
				minSubtotalCents: null,
			},
			...legacyRateMap([
				{ id: "a", taxClassId: "standard", zoneId: "z", rateBps: 500, appliesToShipping: false },
				{ id: "b", taxClassId: "gst18", zoneId: "z", rateBps: 1800, appliesToShipping: true },
			]),
		};
		const input: TotalsInput = {
			currency: currency("INR"),
			lines: [
				{ unitPriceCents: cents(49_900), qty: 1, taxClassId: "gst18" },
				{ unitPriceCents: cents(39_800), qty: 1, taxClassId: "standard" },
			],
			rules,
		};
		const got = computeTotals(input);
		expect(got).toEqual(legacyComputeTotals(input));
		expect([got.lineBreakdown.map((l) => l.taxCents), got.shippingTaxCents, got.taxCents]).toEqual([
			[8982, 1990],
			882,
			11_854,
		]);
	});
});
