import { describe, expect, test } from "vitest";
import { cents, type Cents } from "../../src/money/cents.js";
import {
	itemizeTaxLines,
	orderTaxRows,
	recordedTaxTotalsDisplay,
	taxTotalsDisplayOf,
} from "../../src/orders/order-tax-rows.js";
import { LEGACY_TAX_SETTINGS, NEW_STORE_TAX_SETTINGS } from "../../src/pricing/tax-settings.js";

/**
 * Issue #422: the order's frozen v1 tax snapshot → one display row per tax, the
 * ONE helper behind the order pages, the order emails and the admin. Rows are the
 * stored amounts, never recomputed from a rate, and must add up to the order's
 * tax total; anything else falls back to the single "Tax" row.
 */
function line(lineIndex: number, label: string, rateBps: number, taxCents: number) {
	return {
		lineIndex,
		taxClassId: `class-${label}`,
		taxableCents: 10_000,
		rateBps,
		label,
		taxCents,
	};
}

function v1(over: Record<string, unknown> = {}) {
	return {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		located: true,
		lines: [line(0, "GST 18%", 1800, 1800), line(1, "GST 5%", 500, 250)],
		shipping: { taxableCents: 500, rateBps: 1800, label: "GST 18%", taxCents: 90 },
		...over,
	};
}

function totals(taxBreakdown: unknown, tax: number) {
	return { tax: tax as Cents, taxBreakdown };
}

describe("orderTaxRows", () => {
	test("multi-rate: one row per label, lines then shipping, first-seen order; shipping tax joins its rate's row", () => {
		expect(orderTaxRows(totals(v1(), 2140))).toEqual([
			{ label: "GST 18%", amountCents: 1890 },
			{ label: "GST 5%", amountCents: 250 },
		]);
	});

	test("the rows add up to the order's tax total", () => {
		const rows = orderTaxRows(totals(v1(), 2140)) ?? [];
		expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(2140);
	});

	test("one rate still itemizes as one labelled row", () => {
		const snapshot = v1({ lines: [line(0, "VAT", 2000, 200)], shipping: null });
		expect(orderTaxRows(totals(snapshot, 200))).toEqual([{ label: "VAT", amountCents: 200 }]);
	});

	test("shipping taxed at a rate no line carries gets its own row", () => {
		const snapshot = v1({
			lines: [line(0, "Reduced", 500, 50)],
			shipping: { taxableCents: 1000, rateBps: 2000, label: "Standard", taxCents: 200 },
		});
		expect(orderTaxRows(totals(snapshot, 250))).toEqual([
			{ label: "Reduced", amountCents: 50 },
			{ label: "Standard", amountCents: 200 },
		]);
	});

	test("a zero-tax line (untaxed product, 0% rate) adds no row", () => {
		const snapshot = v1({
			lines: [line(0, "Standard", 2000, 200), line(1, "Zero rate", 0, 0)],
			shipping: null,
		});
		expect(orderTaxRows(totals(snapshot, 200))).toEqual([{ label: "Standard", amountCents: 200 }]);
	});

	test("prices entered WITH tax itemize the same stored amounts (the tax inside the prices)", () => {
		const snapshot = v1({ pricesIncludeTax: true });
		expect(orderTaxRows(totals(snapshot, 2140))).toEqual([
			{ label: "GST 18%", amountCents: 1890 },
			{ label: "GST 5%", amountCents: 250 },
		]);
	});

	describe("fallback to the single total (null)", () => {
		test("no snapshot: the Phase-4 stub (null) or anything malformed", () => {
			expect(orderTaxRows(totals(null, 0))).toBeNull();
			expect(orderTaxRows(totals(undefined, 0))).toBeNull();
			expect(orderTaxRows(totals({ v: 1, junk: true }, 100))).toBeNull();
		});

		test("a pre-ADR-0030 (v0) snapshot: amounts only, no label to show", () => {
			const legacy = {
				lines: [{ taxClassId: "standard", discountedCents: 1000, taxCents: 100 }],
				shippingTaxCents: 0,
			};
			expect(orderTaxRows(totals(legacy, 100))).toBeNull();
		});

		test("a snapshot with no tax in it (tax off, or every line untaxed)", () => {
			const snapshot = v1({ lines: [line(0, "Zero", 0, 0)], shipping: null });
			expect(orderTaxRows(totals(snapshot, 0))).toBeNull();
			expect(orderTaxRows(totals(v1({ lines: [], shipping: null }), 0))).toBeNull();
		});

		test("rows that do not add up to the order's tax total: the total is authoritative, no cent is invented or moved", () => {
			expect(orderTaxRows(totals(v1(), 2141))).toBeNull();
			expect(orderTaxRows(totals(v1(), 2139))).toBeNull();
		});

		test("a blank label: nothing honest to print as the row's name", () => {
			const snapshot = v1({ lines: [line(0, "  ", 2000, 200)], shipping: null });
			expect(orderTaxRows(totals(snapshot, 200))).toBeNull();
		});
	});
});

describe("itemizeTaxLines (shared with the checkout quote)", () => {
	test("groups by label in first-seen order and skips zero amounts", () => {
		expect(
			itemizeTaxLines([
				{ label: "B", taxCents: cents(1) },
				{ label: "A", taxCents: cents(0) },
				{ label: "A", taxCents: cents(2) },
				{ label: "B", taxCents: cents(3) },
			]),
		).toEqual([
			{ label: "B", amountCents: 4 },
			{ label: "A", amountCents: 2 },
		]);
	});
});

function recorded(raw: unknown) {
	return recordedTaxTotalsDisplay({ taxBreakdown: raw });
}

describe("recordedTaxTotalsDisplay (#478)", () => {
	const base = {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		lines: [],
		shipping: null,
	};

	test("the display the order was placed under", () => {
		expect(recorded({ ...base, totalsDisplay: "itemized" })).toBe("itemized");
		expect(recorded({ ...base, totalsDisplay: "single" })).toBe("single");
	});

	test("none recorded — an order placed before #478, a v0 or no snapshot: undefined (the caller falls back to the live option)", () => {
		expect(recorded(base)).toBeUndefined();
		expect(recorded({ ...base, totalsDisplay: "none" })).toBeUndefined();
		expect(recorded(null)).toBeUndefined();
		expect(recorded({ lines: [], shippingTaxCents: 0 })).toBeUndefined();
	});
});

describe("taxTotalsDisplayOf", () => {
	test("the saved setting wins", () => {
		expect(taxTotalsDisplayOf({ ...NEW_STORE_TAX_SETTINGS, totalsDisplay: "single" })).toBe(
			"single",
		);
		expect(taxTotalsDisplayOf({ ...LEGACY_TAX_SETTINGS, totalsDisplay: "itemized" })).toBe(
			"itemized",
		);
	});

	test("nothing saved: an order that was charged tax came from a store that already charged it — today's single row (the upgrade rule)", () => {
		expect(taxTotalsDisplayOf(undefined)).toBe("single");
	});
});
