/**
 * The order's presentation rules shared by `/orders/<id>` and the account's own
 * order page (`lib/order-view.ts`) — so the two pages cannot disagree about the
 * same order (QA U-5, U-13).
 *
 *  - the totals rows: "Not calculated" is decided by the plugin's
 *    `orderTotalsFlags`, never printed as $0.00;
 *  - the total's label: "Paid" for every state the money was captured in, never
 *    for a quote, and "Refunded" once it went back in full;
 *  - the step tracker: Payment is "completed" only for an order that was paid.
 */
import { buildCheckoutTotals, orderTotalsFlags } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { orderProgress, orderSumRows, orderTotalLabel } from "../src/lib/order-view.js";

const BREAKDOWN = {
	currency: "USD",
	subtotalCents: 2400,
	discountCents: 0,
	shippingCents: 0,
	taxCents: 0,
	totalCents: 2400,
	appliedCouponCode: null,
};

describe("orderTotalLabel — what the total row is called", () => {
	test.each(["paid", "processing", "shipped", "delivered", "completed"])(
		"%s: the money was captured, so the total is what was PAID",
		(state) => {
			expect(orderTotalLabel(state)).toBe("Paid");
		},
	);

	test("refunded: the order only reaches this state when the refund covers it in full", () => {
		expect(orderTotalLabel("refunded")).toBe("Refunded");
	});

	test.each(["pending", "expired", "failed", "cancelled", "something_new"])(
		"%s: nothing (or nothing that is kept) was paid, so it is only a Total",
		(state) => {
			expect(orderTotalLabel(state)).toBe("Total");
		},
	);
});

describe("orderSumRows — the totals rows, by the order page's own rule", () => {
	test("an order priced with no method and no zone says Not calculated, never $0.00", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN },
			{
				locale: "en",
				...orderTotalsFlags({ shippingZoneId: null, shippingMethodId: null }),
			},
		);
		const rows = orderSumRows(totals);
		expect(rows.map((row) => row.label)).toEqual(["Subtotal", "Discount", "Shipping", "Tax"]);
		const byLabel = new Map(rows.map((row) => [row.label, row]));
		expect(byLabel.get("Shipping")?.amount).toEqual({ money: null, label: "Not calculated" });
		expect(byLabel.get("Tax")?.amount).toEqual({ money: null, label: "Not calculated" });
		expect(byLabel.get("Discount")?.fallback).toBe("No coupon applied");
	});

	test("a priced method and zone print their real figures, even a zero", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN },
			{
				locale: "en",
				...orderTotalsFlags({ shippingZoneId: "z1", shippingMethodId: "m1" }),
			},
		);
		const byLabel = new Map(orderSumRows(totals).map((row) => [row.label, row]));
		expect(byLabel.get("Shipping")?.amount.label).toBe("$0.00");
		expect(byLabel.get("Tax")?.amount.label).toBe("$0.00");
	});

	test("an applied coupon names itself on the discount row", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN, discountCents: 500, totalCents: 1900, appliedCouponCode: "SAVE5" },
			{ locale: "en", shippingSelected: false, taxZoneSelected: false },
		);
		expect(orderSumRows(totals)[1]?.label).toBe("Discount · SAVE5");
	});
});

describe("orderProgress — the step tracker never claims a payment that did not happen", () => {
	test.each(["paid", "processing", "shipped", "delivered", "completed", "refunded"])(
		"%s: paid, so the tracker is at Order with Payment completed",
		(state) => {
			expect(orderProgress(state)).toEqual({ current: "order", halted: false });
		},
	);

	test("pending: Payment is the step in progress, not a completed one", () => {
		expect(orderProgress("pending")).toEqual({ current: "payment", halted: false });
	});

	test.each(["expired", "failed"])(
		"%s: the journey stopped AT Payment — it is not completed",
		(state) => {
			expect(orderProgress(state)).toEqual({ current: "payment", halted: true });
		},
	);

	test("cancelled (or a state this page does not know): no tracker — the public read cannot say whether it was paid first", () => {
		expect(orderProgress("cancelled")).toBeNull();
		expect(orderProgress("something_new")).toBeNull();
	});
});
