import { describe, expect, test } from "vitest";
import type { QuoteBreakdownWire, QuoteTaxWire } from "../src/product-commerce/commerce-client.js";
import { buildCheckoutTotals } from "../src/storefront/checkout-view-model.js";

/**
 * PR 2a (ADR-0031): the cart & checkout tax display — prices shown with or
 * without tax, tax totals itemized or as one row. Every row still sums to the
 * total the buyer pays.
 */
const OPTS = { locale: "en-US", shippingSelected: true, taxZoneSelected: true };

function tax(over: Partial<QuoteTaxWire> = {}): QuoteTaxWire {
	return {
		enabled: true,
		located: true,
		pricesIncludeTax: false,
		displayCart: "excl",
		totalsDisplay: "itemized",
		lineTaxCents: 200,
		itemized: [
			{ label: "VAT", amountCents: 250 },
			{ label: "Reduced", amountCents: 50 },
		],
		...over,
	};
}

/** Prices WITHOUT tax: 1000 + 500 shipping; 250 line tax… */
const EXCL: QuoteBreakdownWire = {
	currency: "USD",
	subtotalCents: 1000,
	discountCents: 0,
	shippingCents: 500,
	taxCents: 300,
	totalCents: 1800,
	appliedCouponCode: null,
};

function sumOf(t: ReturnType<typeof buildCheckoutTotals>): number {
	const rows = t.taxRows.reduce((s, r) => s + (r.amount.money?.amount ?? 0), 0);
	return (
		(t.subtotal.money?.amount ?? 0) -
		(t.discount.money?.amount ?? 0) +
		(t.shipping.money?.amount ?? 0) +
		rows
	);
}

describe("no tax display info (orders, pre-2a callers): today's single Tax row", () => {
	test("one row labelled Tax with the whole tax; no note", () => {
		const t = buildCheckoutTotals(EXCL, OPTS);
		expect(t.taxRows.map((r) => [r.label, r.amount.label])).toEqual([["Tax", "$3.00"]]);
		expect(t.taxIncludedNote).toBeNull();
	});
});

describe("displayed without tax", () => {
	test("itemized: one row per tax label, adding up to the total", () => {
		const t = buildCheckoutTotals({ ...EXCL, tax: tax() }, OPTS);
		expect(t.taxRows.map((r) => [r.label, r.amount.label])).toEqual([
			["VAT", "$2.50"],
			["Reduced", "$0.50"],
		]);
		expect(sumOf(t)).toBe(1800);
	});

	test("single: one Tax row", () => {
		const t = buildCheckoutTotals({ ...EXCL, tax: tax({ totalsDisplay: "single" }) }, OPTS);
		expect(t.taxRows.map((r) => [r.label, r.amount.label])).toEqual([["Tax", "$3.00"]]);
	});

	test("prices entered WITH tax are shown net: the included line tax moves into the tax rows", () => {
		// Gross 1200 incl. 200 tax; shipping 500 + 100 tax; total 1800.
		const t = buildCheckoutTotals(
			{
				...EXCL,
				subtotalCents: 1200,
				taxCents: 300,
				totalCents: 1800,
				tax: tax({ pricesIncludeTax: true, totalsDisplay: "single" }),
			},
			OPTS,
		);
		expect(t.subtotal.label).toBe("$10.00");
		expect(t.shipping.label).toBe("$5.00");
		expect(t.taxRows.map((r) => r.amount.label)).toEqual(["$3.00"]);
		expect(sumOf(t)).toBe(1800);
		expect(t.total.label).toBe("$18.00");
	});

	test("with a coupon the subtotal and discount are both shown net, and still sum", () => {
		// Gross 1200, 10% off → 1080 incl. 180 tax; shipping 500 + 100.
		const t = buildCheckoutTotals(
			{
				...EXCL,
				subtotalCents: 1200,
				discountCents: 120,
				taxCents: 280,
				totalCents: 1680,
				appliedCouponCode: "TEN",
				tax: tax({ pricesIncludeTax: true, lineTaxCents: 180, totalsDisplay: "single" }),
			},
			OPTS,
		);
		expect(t.subtotal.label).toBe("$10.00");
		expect(t.discount.label).toBe("$1.00");
		expect(sumOf(t)).toBe(1680);
	});
});

describe("displayed with tax", () => {
	test("prices without tax are shown gross; no tax row; the total carries an 'includes' note", () => {
		const t = buildCheckoutTotals(
			{ ...EXCL, tax: tax({ displayCart: "incl", totalsDisplay: "single" }) },
			OPTS,
		);
		expect(t.subtotal.label).toBe("$12.00");
		expect(t.shipping.label).toBe("$6.00");
		expect(t.taxRows).toEqual([]);
		expect(t.taxIncludedNote).toBe("Includes $3.00 tax");
		expect(sumOf(t)).toBe(1800);
	});

	test("itemized: the note names each tax", () => {
		const t = buildCheckoutTotals({ ...EXCL, tax: tax({ displayCart: "incl" }) }, OPTS);
		expect(t.taxIncludedNote).toBe("Includes $2.50 VAT, $0.50 Reduced");
	});

	test("prices entered with tax are shown as entered", () => {
		const t = buildCheckoutTotals(
			{
				...EXCL,
				subtotalCents: 1200,
				tax: tax({ pricesIncludeTax: true, displayCart: "incl", totalsDisplay: "single" }),
			},
			OPTS,
		);
		expect(t.subtotal.label).toBe("$12.00");
		expect(t.shipping.label).toBe("$6.00");
		expect(sumOf(t)).toBe(1800);
	});
});

describe("tax off, and tax not located", () => {
	test("tax switched off renders exactly as before 2a: the one Tax row, prices as entered", () => {
		const off = { ...EXCL, taxCents: 0, totalCents: 1500 };
		const opts = { ...OPTS, taxZoneSelected: false };
		const t = buildCheckoutTotals(
			{ ...off, tax: tax({ enabled: false, displayCart: "incl", itemized: [] }) },
			opts,
		);
		expect(t).toEqual(buildCheckoutTotals(off, opts));
		expect(t.taxRows.map((r) => [r.label, r.amount.money])).toEqual([["Tax", null]]);
	});

	test("a digital cart taxed at the shop's address is calculated even with no shipping zone", () => {
		const t = buildCheckoutTotals(
			{ ...EXCL, tax: tax({ located: true }) },
			{ ...OPTS, taxZoneSelected: false },
		);
		expect(t.tax.money?.amount).toBe(300);
		expect(t.taxRows[0]?.amount.money).not.toBeNull();
	});

	test("not located: one 'Not calculated' Tax row, prices shown as entered", () => {
		const t = buildCheckoutTotals(
			{ ...EXCL, taxCents: 0, totalCents: 1500, tax: tax({ located: false, displayCart: "incl" }) },
			{ ...OPTS, taxZoneSelected: false },
		);
		expect(t.taxRows.map((r) => [r.label, r.amount.money])).toEqual([["Tax", null]]);
		expect(t.subtotal.label).toBe("$10.00");
		expect(t.taxIncludedNote).toBeNull();
	});
});
