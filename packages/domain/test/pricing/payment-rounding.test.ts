import {
	cents,
	computeTotals,
	currency,
	currencyPaymentIncrement,
	SUPPORTED_CURRENCIES,
	type RulesSnapshot,
	type TotalsInput,
} from "@otta-sh/domain";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { roundHalfUpToMultiple } from "../../src/pricing/round.js";

/**
 * ADR-0033's amendment: a currency with a payment increment (KWD, BHD, OMR, JOD:
 * 10 minor units) has its FINAL total rounded half-up to it, the difference shown
 * as `roundingCents`; every part stays exact, and every other currency's
 * breakdown is exactly what it always was.
 */

function rules(shippingCents: number, taxBps: number): RulesSnapshot {
	return {
		shippingMethod: {
			zoneId: "z1",
			methodId: "m-flat",
			type: "flat_rate",
			amountCents: cents(shippingCents),
			minSubtotalCents: null,
		},
		taxRatesByClass: { standard: taxBps },
		shippingTaxable: false,
		shippingTaxClassId: "standard",
	};
}

function oneLine(code: string, unitPrice: number, shipping = 0, taxBps = 0): TotalsInput {
	return {
		currency: currency(code),
		lines: [{ unitPriceCents: cents(unitPrice), qty: 1, taxClassId: "standard" }],
		rules: rules(shipping, taxBps),
	};
}

const INCREMENT_CODES = SUPPORTED_CURRENCIES.filter(
	(row) => currencyPaymentIncrement(row.code) !== undefined,
).map((row) => row.code);
const PLAIN_CODES = SUPPORTED_CURRENCIES.filter(
	(row) => currencyPaymentIncrement(row.code) === undefined,
).map((row) => row.code);

describe("roundHalfUpToMultiple", () => {
	test("half-up to the nearest multiple", () => {
		expect(roundHalfUpToMultiple(1234, 10)).toBe(1230);
		expect(roundHalfUpToMultiple(1235, 10)).toBe(1240);
		expect(roundHalfUpToMultiple(1239, 10)).toBe(1240);
		expect(roundHalfUpToMultiple(1230, 10)).toBe(1230);
		expect(roundHalfUpToMultiple(0, 10)).toBe(0);
		expect(roundHalfUpToMultiple(4, 10)).toBe(0);
		expect(roundHalfUpToMultiple(5, 10)).toBe(10);
		// An odd increment: exact halves cannot occur, the nearest wins.
		expect(roundHalfUpToMultiple(7, 5)).toBe(5);
		expect(roundHalfUpToMultiple(8, 5)).toBe(10);
	});

	test("never leaves the safe-integer range for an increment of 10", () => {
		expect(roundHalfUpToMultiple(Number.MAX_SAFE_INTEGER, 10)).toBe(Number.MAX_SAFE_INTEGER - 1);
		expect(Number.isSafeInteger(roundHalfUpToMultiple(Number.MAX_SAFE_INTEGER - 5, 10))).toBe(true);
	});

	test("refuses a negative or fractional amount and a non-positive increment", () => {
		expect(() => roundHalfUpToMultiple(-1, 10)).toThrow(RangeError);
		expect(() => roundHalfUpToMultiple(1.5, 10)).toThrow(RangeError);
		expect(() => roundHalfUpToMultiple(10, 0)).toThrow(RangeError);
		expect(() => roundHalfUpToMultiple(10, -10)).toThrow(RangeError);
	});
});

describe("the currency table's payment increments", () => {
	test("exactly the four three-decimal currencies carry one, of 10", () => {
		expect(INCREMENT_CODES.toSorted()).toEqual(["BHD", "JOD", "KWD", "OMR"]);
		for (const code of INCREMENT_CODES) expect(currencyPaymentIncrement(code)).toBe(10);
		expect(currencyPaymentIncrement("XYZ")).toBeUndefined();
	});
});

describe("computeTotals — the payment rounding line", () => {
	test("KWD 1.234 rounds DOWN to 1.230: rounding −4, every part exact", () => {
		const b = computeTotals(oneLine("KWD", 1234));
		expect(b.subtotalCents).toBe(1234);
		expect(b.totalCents).toBe(1230);
		expect(b.roundingCents).toBe(-4);
	});

	test("KWD 1.235 rounds UP to 1.240 (half-up): rounding +5", () => {
		const b = computeTotals(oneLine("KWD", 1235));
		expect(b.totalCents).toBe(1240);
		expect(b.roundingCents).toBe(5);
	});

	test("a KWD total already a multiple of 0.010 carries rounding 0 — the field is present", () => {
		const b = computeTotals(oneLine("KWD", 1230));
		expect(b.totalCents).toBe(1230);
		expect(b.roundingCents).toBe(0);
		expect(Object.hasOwn(b, "roundingCents")).toBe(true);
	});

	test("only the FINAL total is rounded: shipping and tax stay exact (BHD 1.001 + 0.002 shipping + 5% tax)", () => {
		// 1001 × 5% = 50.05 → 50 (half-up per line); total 1001 + 2 + 50 = 1053 → 1050.
		const b = computeTotals(oneLine("BHD", 1001, 2, 500));
		expect(b.shippingCents).toBe(2);
		expect(b.taxCents).toBe(50);
		expect(b.totalCents).toBe(1050);
		expect(b.roundingCents).toBe(-3);
	});

	test("USD, JPY and EUR breakdowns carry no rounding field at all", () => {
		for (const code of ["USD", "JPY", "EUR"]) {
			const b = computeTotals(oneLine(code, 1234, 7, 725));
			expect(Object.hasOwn(b, "roundingCents"), code).toBe(false);
			expect(b.totalCents, code).toBe(
				b.subtotalCents - b.discountCents + b.shippingCents + b.taxCents,
			);
		}
	});
});

describe("computeTotals — payment rounding properties (fast-check)", () => {
	const amount = fc.integer({ min: 0, max: 10_000_000 });
	const bps = fc.integer({ min: 0, max: 10_000 });

	test("an increment currency: total % increment === 0, |rounding| ≤ increment/2, parts + rounding = total", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...INCREMENT_CODES),
				amount,
				fc.integer({ min: 1, max: 5 }),
				amount,
				bps,
				(code, unit, qty, shipping, taxBps) => {
					const b = computeTotals({
						currency: currency(code),
						lines: [{ unitPriceCents: cents(unit), qty, taxClassId: "standard" }],
						rules: rules(shipping, taxBps),
					});
					const increment = currencyPaymentIncrement(code) as number;
					const rounding = b.roundingCents as number;
					expect(b.roundingCents).toBeDefined();
					expect(b.totalCents % increment).toBe(0);
					expect(Math.abs(rounding)).toBeLessThanOrEqual(increment / 2);
					expect(b.subtotalCents - b.discountCents + b.shippingCents + b.taxCents + rounding).toBe(
						b.totalCents,
					);
				},
			),
		);
	});

	test("every other listed currency: no rounding field, and the total is the exact sum of the parts", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...PLAIN_CODES),
				amount,
				fc.integer({ min: 1, max: 5 }),
				amount,
				bps,
				(code, unit, qty, shipping, taxBps) => {
					const b = computeTotals({
						currency: currency(code),
						lines: [{ unitPriceCents: cents(unit), qty, taxClassId: "standard" }],
						rules: rules(shipping, taxBps),
					});
					expect(Object.hasOwn(b, "roundingCents")).toBe(false);
					expect(b.subtotalCents - b.discountCents + b.shippingCents + b.taxCents).toBe(
						b.totalCents,
					);
				},
			),
		);
	});
});
