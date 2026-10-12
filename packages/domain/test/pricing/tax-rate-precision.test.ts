import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import {
	buildOrderTaxSnapshot,
	readOrderTaxSnapshot,
} from "../../src/orders/order-tax-snapshot.js";
import type { TaxRate } from "../../src/ports/tax-rules-store.js";
import { applyRateTable, rateTableOf } from "../../src/pricing/rate-table-calculator.js";
import type { TaxRequest } from "../../src/pricing/tax-calculator.js";
import {
	bpsOfPpm,
	canonicalTaxRateValue,
	finerRatePpm,
	normalizeTaxRateValue,
	ratePpmOf,
	taxRateValueOfPpm,
} from "../../src/pricing/tax-rate-precision.js";
import { TaxRateDuplicateError } from "../../src/pricing/tax-rate-uniqueness.js";
import type { TotalsBreakdown } from "../../src/pricing/types.js";
import { validateTaxResult } from "../../src/pricing/validate-tax-result.js";

// #425: a built-in rate finer than a basis point — 8.875% (New York City) — is a
// rate in MILLIONTHS (0.0001%, WooCommerce's own 4-decimal precision), carried in
// an optional `ratePpm` beside the whole-bps `rateBps`. A rate that is a whole
// basis point keeps exactly its old shape: no `ratePpm` key anywhere.

const USD = currency("USD");
const NYC = 88_750; // 8.875%

function rate(over: Partial<TaxRate> = {}): TaxRate {
	return {
		id: "r1",
		taxClassId: "standard",
		zoneId: "nyc",
		rateBps: 888,
		ratePpm: NYC,
		appliesToShipping: true,
		...over,
	};
}

function request(amount: number, over: Partial<TaxRequest> = {}): TaxRequest {
	return {
		purpose: "quote",
		currency: USD,
		pricesIncludeTax: false,
		lines: [
			{
				lineId: "l0",
				quantity: 1,
				unitPriceCents: cents(amount),
				amountCents: cents(amount),
				taxClassId: "standard",
				taxStatus: "taxable",
				requiresShipping: true,
			},
		],
		shipping: null,
		origin: null,
		destination: null,
		zoneId: "nyc",
		...over,
	};
}

describe("the rate value: rateBps + an optional finer ratePpm", () => {
	test("ratePpmOf reads ratePpm when present, else the whole basis points × 100", () => {
		expect(ratePpmOf({ rateBps: 888, ratePpm: NYC })).toBe(NYC);
		expect(ratePpmOf({ rateBps: 725 })).toBe(72_500);
		expect(ratePpmOf({ rateBps: 0 })).toBe(0);
	});

	test("a stale ratePpm — one an older build left behind when it edited only rateBps — is ignored", () => {
		// The old build edited 8.875% → 9% and carried ratePpm along: rateBps wins.
		expect(ratePpmOf({ rateBps: 900, ratePpm: NYC })).toBe(90_000);
		expect(canonicalTaxRateValue({ rateBps: 900, ratePpm: NYC })).toEqual({ rateBps: 900 });
		// Malformed or redundant values are not a finer rate either.
		expect(finerRatePpm({ rateBps: 888, ratePpm: 88_750.5 })).toBeUndefined();
		expect(finerRatePpm({ rateBps: 888, ratePpm: -1 })).toBeUndefined();
		expect(finerRatePpm({ rateBps: 888, ratePpm: null })).toBeUndefined();
		expect(finerRatePpm({ rateBps: 888, ratePpm: "88750" })).toBeUndefined();
		expect(finerRatePpm({ rateBps: 888, ratePpm: 88_800 })).toBeUndefined();
		expect(finerRatePpm({ rateBps: 888, ratePpm: NYC })).toBe(NYC);
	});

	test("a corrupt rateBps fails closed, as computeLineTax always did", () => {
		expect(() => ratePpmOf({ rateBps: 7.5 })).toThrow(RangeError);
		expect(() => ratePpmOf({ rateBps: -1 })).toThrow(RangeError);
		expect(() => ratePpmOf({ rateBps: Number.NaN })).toThrow(RangeError);
	});

	test("bpsOfPpm rounds half up to the nearest whole basis point", () => {
		expect(bpsOfPpm(NYC)).toBe(888);
		expect(bpsOfPpm(88_749)).toBe(887);
		expect(bpsOfPpm(72_500)).toBe(725);
		expect(bpsOfPpm(1)).toBe(0);
		// The half-up boundary.
		expect(bpsOfPpm(49)).toBe(0);
		expect(bpsOfPpm(50)).toBe(1);
		expect(bpsOfPpm(149)).toBe(1);
		expect(bpsOfPpm(150)).toBe(2);
	});

	test("taxRateValueOfPpm is canonical: a whole basis point carries no ratePpm", () => {
		expect(taxRateValueOfPpm(NYC)).toEqual({ rateBps: 888, ratePpm: NYC });
		expect(taxRateValueOfPpm(72_500)).toEqual({ rateBps: 725 });
		expect(taxRateValueOfPpm(0)).toEqual({ rateBps: 0 });
		expect(() => taxRateValueOfPpm(-1)).toThrow(RangeError);
		expect(() => taxRateValueOfPpm(1.5)).toThrow(RangeError);
	});

	test("normalizeTaxRateValue keeps a bps-only value as is, canonicalizes ppm, refuses a mismatch", () => {
		expect(normalizeTaxRateValue({ rateBps: 725 })).toEqual({ rateBps: 725 });
		expect(normalizeTaxRateValue({ rateBps: 888, ratePpm: NYC })).toEqual({
			rateBps: 888,
			ratePpm: NYC,
		});
		expect(normalizeTaxRateValue({ rateBps: 725, ratePpm: 72_500 })).toEqual({ rateBps: 725 });
		expect(() => normalizeTaxRateValue({ rateBps: 900, ratePpm: NYC })).toThrow(RangeError);
		expect(() => normalizeTaxRateValue({ rateBps: 888, ratePpm: 88_750.5 })).toThrow(RangeError);
	});
});

describe("the built-in rate table charges the exact 8.875%", () => {
	test("prices without tax: round_half_up(amount × 88750 / 1e6), where 8.88% would charge more", () => {
		// $1,000.00 at 8.875% is $88.75 — at the rounded 8.88% it would be $88.80.
		const r = applyRateTable(request(100_000), rateTableOf([rate()]), new Map());
		expect(r.lines[0]).toMatchObject({ rateBps: 888, ratePpm: NYC, taxCents: 8875 });
		// 887.5 rounds half up, as every rate does.
		const small = applyRateTable(request(10_000), rateTableOf([rate()]), new Map());
		expect(small.lines[0]?.taxCents).toBe(888);
	});

	test("prices with tax: round_half_down(G × 88750 / 1088750)", () => {
		const r = applyRateTable(
			request(108_875, { pricesIncludeTax: true }),
			rateTableOf([rate()]),
			new Map(),
		);
		expect(r.lines[0]?.taxCents).toBe(8875); // exactly the tax inside $1,088.75
	});

	test("prices with tax: an EXACT half at millionths scale rounds DOWN", () => {
		// 64 ppm (0.0064%): 23439 × 64 / 1000064 = 1.5 exactly → 1 (half up would be 2).
		const tiny = rate({ rateBps: 1, ratePpm: 64 });
		const r = applyRateTable(
			request(23_439, { pricesIncludeTax: true }),
			rateTableOf([tiny]),
			new Map(),
		);
		expect(r.lines[0]).toMatchObject({ rateBps: 1, ratePpm: 64, taxCents: 1 });
		// And 7813 × 64 / 1000064 = 0.5 exactly → 0.
		const half = applyRateTable(
			request(7813, { pricesIncludeTax: true }),
			rateTableOf([tiny]),
			new Map(),
		);
		expect(half.lines[0]?.taxCents).toBe(0);
	});

	test("a stale ratePpm is charged at rateBps — what the build that wrote it meant", () => {
		const r = applyRateTable(
			request(100_000),
			rateTableOf([rate({ rateBps: 900, ratePpm: NYC })]),
			new Map(),
		);
		expect(r.lines[0]).toEqual({ lineId: "l0", rateBps: 900, label: "standard", taxCents: 9000 });
	});

	test("shipping and round-at-subtotal use the exact rate too", () => {
		const r = applyRateTable(
			request(100_000, { shipping: { amountCents: cents(100_000), methodId: "m" } }),
			rateTableOf([rate()]),
			new Map(),
			{ roundAtSubtotal: true },
		);
		expect(r.lines[0]?.taxCents).toBe(8875);
		expect(r.shipping).toMatchObject({ rateBps: 888, ratePpm: NYC, taxCents: 8875 });
	});

	test("a whole-bps rate answers exactly as before — no ratePpm key on any line", () => {
		const r = applyRateTable(
			request(100_000, { shipping: { amountCents: cents(500), methodId: "m" } }),
			rateTableOf([rate({ rateBps: 725, ratePpm: undefined })]),
			new Map(),
		);
		expect(r.lines[0]).toEqual({ lineId: "l0", rateBps: 725, label: "standard", taxCents: 7250 });
		expect(r.shipping).toEqual({ rateBps: 725, label: "standard", taxCents: 36 });
	});

	test("an untaxed line shows 0%, with no finer rate left over", () => {
		const req = request(100_000);
		const r = applyRateTable(
			{ ...req, lines: req.lines.map((l) => ({ ...l, taxStatus: "none" as const })) },
			rateTableOf([rate()]),
			new Map(),
		);
		expect(r.lines[0]).toEqual({ lineId: "l0", rateBps: 0, label: "standard", taxCents: 0 });
	});
});

describe("validateTaxResult and the optional ratePpm (ADR-0030 stays backward compatible)", () => {
	const req = request(100_000);
	const answer = (line: Record<string, unknown>) => ({
		ok: true,
		currency: USD,
		lines: [{ lineId: "l0", label: "NY", taxCents: 8875, ...line }],
		shipping: null,
	});

	test("an answer without ratePpm (or with ratePpm: null) passes unchanged", () => {
		const ok = validateTaxResult(req, answer({ rateBps: 888 }));
		expect(ok?.lines[0]).toEqual({ lineId: "l0", rateBps: 888, label: "NY", taxCents: 8875 });
		const nulled = validateTaxResult(req, answer({ rateBps: 888, ratePpm: null }));
		expect(nulled?.lines[0]).toEqual({ lineId: "l0", rateBps: 888, label: "NY", taxCents: 8875 });
	});

	test("a consistent ratePpm is kept; a whole-bps one is dropped as redundant", () => {
		expect(validateTaxResult(req, answer({ rateBps: 888, ratePpm: NYC }))?.lines[0]).toEqual({
			lineId: "l0",
			rateBps: 888,
			ratePpm: NYC,
			label: "NY",
			taxCents: 8875,
		});
		expect(
			validateTaxResult(req, answer({ rateBps: 888, ratePpm: 88_800 }))?.lines[0],
		).not.toHaveProperty("ratePpm");
	});

	test("a ratePpm that disagrees with rateBps, is not an integer, or is out of range is refused", () => {
		expect(validateTaxResult(req, answer({ rateBps: 900, ratePpm: NYC }))).toBeNull();
		expect(validateTaxResult(req, answer({ rateBps: 888, ratePpm: 88_750.5 }))).toBeNull();
		expect(validateTaxResult(req, answer({ rateBps: 888, ratePpm: "88750" }))).toBeNull();
		expect(validateTaxResult(req, answer({ rateBps: 0, ratePpm: -1 }))).toBeNull();
		expect(
			validateTaxResult(req, answer({ rateBps: 100_000, ratePpm: 10_000_001, taxCents: 0 })),
		).toBeNull();
	});
});

/** A v1 snapshot with no lines and the given shipping line. */
function shippingOnlySnapshot(shipping: Record<string, unknown>) {
	return {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		lines: [],
		shipping,
	};
}

describe("the order's frozen snapshot keeps the exact rate", () => {
	const breakdown = {
		lineBreakdown: [{ taxClassId: "standard", discountedCents: cents(100_000) }],
		shippingCents: cents(0),
	} as unknown as TotalsBreakdown;

	test("an 8.875% line writes ratePpm and reads it back", () => {
		const result = applyRateTable(request(100_000), rateTableOf([rate()]), new Map());
		const snap = buildOrderTaxSnapshot(
			breakdown,
			{ calculatorId: "otta.rate-table", result },
			true,
		);
		expect(snap.lines[0]).toMatchObject({ rateBps: 888, ratePpm: NYC, taxCents: 8875 });
		expect(readOrderTaxSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
	});

	test("a snapshot written before #425 (no ratePpm) reads back identically, with no key added", () => {
		const old = {
			v: 1,
			calculatorId: "otta.rate-table",
			pricesIncludeTax: false,
			located: true,
			lines: [
				{
					lineIndex: 0,
					taxClassId: "standard",
					taxableCents: 100_000,
					rateBps: 725,
					label: "Standard",
					taxCents: 7250,
				},
			],
			shipping: { taxableCents: 500, rateBps: 725, label: "Standard", taxCents: 36 },
		};
		const read = readOrderTaxSnapshot(JSON.parse(JSON.stringify(old)));
		expect(read).toEqual(old);
		expect(JSON.stringify(read)).toBe(JSON.stringify(old));
	});

	test("a malformed or inconsistent ratePpm is ignored, as any unknown key always was", () => {
		const line = { taxableCents: 500, rateBps: 888, label: "NY", taxCents: 44 };
		for (const ratePpm of ["x", null, -5, 90_000, 88_750.5]) {
			expect(readOrderTaxSnapshot(shippingOnlySnapshot({ ...line, ratePpm }))).toEqual(
				shippingOnlySnapshot(line),
			);
		}
	});
});

describe("the one-rate-per-slot refusal names the exact rate", () => {
	test("TaxRateDuplicateError carries existingRatePpm (whole bps × 100 for an old rate)", () => {
		expect(new TaxRateDuplicateError(rate()).existingRatePpm).toBe(NYC);
		expect(
			new TaxRateDuplicateError(rate({ rateBps: 725, ratePpm: undefined })).existingRatePpm,
		).toBe(72_500);
	});
});
