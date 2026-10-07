import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import {
	applyRateTable,
	inheritShippingTaxClass,
	rateTableOf,
} from "../../src/pricing/rate-table-calculator.js";
import { mulDivRoundHalfUpAny } from "../../src/pricing/round.js";
import type { TaxRequest, TaxRequestLine } from "../../src/pricing/tax-calculator.js";
import type { TaxRate } from "../../src/ports/tax-rules-store.js";

/**
 * PR 2a maths (SPEC §4, ADR-0031): prices entered with tax, rounding at
 * subtotal, and WooCommerce's "shipping tax class based on cart items" rule.
 * Shipping costs are ALWAYS entered without tax (woo-facts-verified Q1).
 */
const USD = currency("USD");

function line(
	lineId: string,
	amount: number,
	taxClassId = "standard",
	over: Partial<TaxRequestLine> = {},
): TaxRequestLine {
	return {
		lineId,
		quantity: 1,
		unitPriceCents: cents(amount),
		amountCents: cents(amount),
		taxClassId,
		taxStatus: "taxable",
		requiresShipping: true,
		...over,
	};
}

function request(over: Partial<TaxRequest> = {}): TaxRequest {
	return {
		purpose: "quote",
		currency: USD,
		pricesIncludeTax: false,
		lines: [line("0", 1000)],
		shipping: null,
		origin: null,
		destination: null,
		zoneId: "z",
		...over,
	};
}

function rate(taxClassId: string, rateBps: number, appliesToShipping = false, id = taxClassId) {
	return { id, taxClassId, zoneId: "z", rateBps, appliesToShipping } satisfies TaxRate;
}

const NO_LABELS = new Map<string, string>();

describe("mulDivRoundHalfUpAny — half-up with any positive denominator", () => {
	test("odd denominators round half up", () => {
		expect(mulDivRoundHalfUpAny(1200, 2000, 12_000)).toBe(200);
		expect(mulDivRoundHalfUpAny(999, 725, 10_725)).toBe(68); // 67.53
		expect(mulDivRoundHalfUpAny(1, 1, 2)).toBe(1); // exactly .5 → up
		expect(mulDivRoundHalfUpAny(1, 1, 3)).toBe(0); // .33 → down
		expect(mulDivRoundHalfUpAny(2, 1, 3)).toBe(1); // .67 → up
	});
	test("refuses negative or non-integer input", () => {
		expect(() => mulDivRoundHalfUpAny(-1, 1, 3)).toThrow(RangeError);
		expect(() => mulDivRoundHalfUpAny(1, 1.5, 3)).toThrow(RangeError);
		expect(() => mulDivRoundHalfUpAny(1, 1, 0)).toThrow(RangeError);
	});
});

describe("SPEC §4 worked examples", () => {
	test("1. inclusive 20%: G=1200 → tax 200, net 1000", () => {
		const r = applyRateTable(
			request({ pricesIncludeTax: true, lines: [line("0", 1200)] }),
			rateTableOf([rate("standard", 2000)]),
			NO_LABELS,
		);
		expect(r.lines[0]?.taxCents).toBe(200);
	});

	test("2. inclusive 7.25%: G=999 → 67.53 → tax 68, net 931", () => {
		const r = applyRateTable(
			request({ pricesIncludeTax: true, lines: [line("0", 999)] }),
			rateTableOf([rate("standard", 725)]),
			NO_LABELS,
		);
		expect(r.lines[0]?.taxCents).toBe(68);
	});

	test("3. exclusive 7.25%, three lines of 199: per line 42; at subtotal 43 allocated 15/14/14", () => {
		const lines = [line("0", 199), line("1", 199), line("2", 199)];
		const table = rateTableOf([rate("standard", 725)]);
		const perLine = applyRateTable(request({ lines }), table, NO_LABELS);
		expect(perLine.lines.map((l) => l.taxCents)).toEqual([14, 14, 14]);
		const atSubtotal = applyRateTable(request({ lines }), table, NO_LABELS, {
			roundAtSubtotal: true,
		});
		expect(atSubtotal.lines.map((l) => l.taxCents)).toEqual([15, 14, 14]);
	});

	test("rounding at subtotal also applies to inclusive prices, per class", () => {
		const lines = [line("0", 199), line("1", 199), line("2", 199)];
		const table = rateTableOf([rate("standard", 725)]);
		// per line: 199·725/10725 = 13.45 → 13 each = 39; at subtotal 597·725/10725 = 40.36 → 40
		const perLine = applyRateTable(request({ lines, pricesIncludeTax: true }), table, NO_LABELS);
		expect(perLine.lines.map((l) => l.taxCents)).toEqual([13, 13, 13]);
		const atSubtotal = applyRateTable(request({ lines, pricesIncludeTax: true }), table, NO_LABELS, {
			roundAtSubtotal: true,
		});
		expect(atSubtotal.lines.map((l) => l.taxCents)).toEqual([14, 13, 13]);
	});

	test("rounding at subtotal groups by class: each class is rounded on its own sum", () => {
		const lines = [line("0", 199), line("1", 199, "reduced"), line("2", 199)];
		const table = rateTableOf([rate("standard", 725), rate("reduced", 500)]);
		const r = applyRateTable(request({ lines }), table, NO_LABELS, { roundAtSubtotal: true });
		// standard: 398·725/10000 = 28.855 → 29 → 15/14; reduced: 9.95 → 10
		expect(r.lines.map((l) => l.taxCents)).toEqual([15, 10, 14]);
	});

	test("4. inclusive 20% with a 10% coupon: discounted G=1080 → tax 180", () => {
		const r = applyRateTable(
			request({
				pricesIncludeTax: true,
				lines: [line("0", 1080, "standard", { unitPriceCents: cents(1200) })],
			}),
			rateTableOf([rate("standard", 2000)]),
			NO_LABELS,
		);
		expect(r.lines[0]?.taxCents).toBe(180);
	});

	test("5. inclusive 20%, shipping 500 taxable at 20%: shipping is EXCLUSIVE → +100", () => {
		const r = applyRateTable(
			request({
				pricesIncludeTax: true,
				lines: [line("0", 1200)],
				shipping: { amountCents: cents(500), methodId: "m" },
			}),
			rateTableOf([rate("standard", 2000, true)]),
			NO_LABELS,
		);
		expect(r.lines[0]?.taxCents).toBe(200);
		expect(r.shipping?.taxCents).toBe(100);
	});
});

describe("shipping tax class — WooCommerce 'based on cart items' (woo-facts-verified Q2)", () => {
	const names = new Map([
		["reduced", "Reduced rate"],
		["books", "Books"],
		["zero", "Zero rate"],
		["standard", "Standard"],
	]);

	test("no taxable line that ships → no shipping tax class (null)", () => {
		expect(inheritShippingTaxClass([], names)).toBeNull();
		expect(
			inheritShippingTaxClass([line("0", 1, "reduced", { requiresShipping: false })], names),
		).toBeNull();
		expect(inheritShippingTaxClass([line("0", 1, "reduced", { taxStatus: "none" })], names)).toBe(
			null,
		);
	});

	test("any line in the standard class → standard", () => {
		expect(
			inheritShippingTaxClass([line("0", 1, "reduced"), line("1", 1, "standard")], names),
		).toBe("standard");
	});

	test("exactly one class → that class", () => {
		expect(
			inheritShippingTaxClass([line("0", 1, "reduced"), line("1", 1, "reduced")], names),
		).toBe("reduced");
	});

	test("several classes → the first by class NAME (WooCommerce's ORDER BY name)", () => {
		// Names: "Books" < "Reduced rate" < "Zero rate" — not id order (books < reduced < zero
		// happens to agree, so use ids whose order differs from their names).
		const byName = new Map([
			["a-zero", "Zero rate"],
			["b-reduced", "Reduced rate"],
		]);
		expect(
			inheritShippingTaxClass([line("0", 1, "a-zero"), line("1", 1, "b-reduced")], byName),
		).toBe("b-reduced");
	});

	test("several classes none of which is declared → standard (WooCommerce's fallback)", () => {
		expect(inheritShippingTaxClass([line("0", 1, "x"), line("1", 1, "y")], new Map())).toBe(
			"standard",
		);
	});

	test("a shipping-only line still counts; a digital line does not", () => {
		expect(
			inheritShippingTaxClass(
				[
					line("0", 1, "standard", { requiresShipping: false }),
					line("1", 1, "reduced", { taxStatus: "shipping_only" }),
				],
				names,
			),
		).toBe("reduced");
	});
});

describe("shipping tax under each shipping-class setting", () => {
	// The INR golden's rates, but with BOTH lines physical (in the golden the standard
	// line is digital, so "based on cart items" also picks gst18 there): gst18 at 18%
	// applies to shipping, standard at 5% does not.
	const table = rateTableOf([rate("gst18", 1800, true), rate("standard", 500, false, "std")]);
	const lines = [line("0", 49_900, "gst18"), line("1", 39_800, "standard")];
	const req = request({ lines, shipping: { amountCents: cents(4900), methodId: "m" } });

	test("legacy (today): the last shipping-flagged rate's class → 882", () => {
		expect(applyRateTable(req, table, NO_LABELS).shipping?.taxCents).toBe(882);
		expect(
			applyRateTable(req, table, NO_LABELS, { shippingTaxClass: { kind: "legacy" } }).shipping
				?.taxCents,
		).toBe(882);
	});

	test("inherit: a standard line picks standard, whose rate does not apply to shipping → untaxed", () => {
		const r = applyRateTable(req, table, NO_LABELS, { shippingTaxClass: { kind: "inherit" } });
		expect(r.shipping).toBeNull();
	});

	test("inherit: a single-class cart taxes shipping at that class's flagged rate", () => {
		const r = applyRateTable(request({ ...req, lines: [lines[0] as TaxRequestLine] }), table, NO_LABELS, {
			shippingTaxClass: { kind: "inherit" },
		});
		expect(r.shipping?.taxCents).toBe(882);
	});

	test("inherit: nothing ships → no shipping tax", () => {
		const r = applyRateTable(
			request({
				...req,
				lines: [line("0", 49_900, "gst18", { requiresShipping: false })],
			}),
			table,
			NO_LABELS,
			{ shippingTaxClass: { kind: "inherit" } },
		);
		expect(r.shipping).toBeNull();
	});

	test("fixed class: that class's flagged rate, or untaxed when its rate is not flagged", () => {
		expect(
			applyRateTable(req, table, NO_LABELS, {
				shippingTaxClass: { kind: "fixed", taxClassId: "gst18" },
			}).shipping?.taxCents,
		).toBe(882);
		expect(
			applyRateTable(req, table, NO_LABELS, {
				shippingTaxClass: { kind: "fixed", taxClassId: "standard" },
			}).shipping,
		).toBeNull();
	});

	test("the shipping tax is computed on the cost as entered, never as tax-inclusive", () => {
		const r = applyRateTable({ ...req, pricesIncludeTax: true }, table, NO_LABELS);
		expect(r.shipping?.taxCents).toBe(882);
	});
});
