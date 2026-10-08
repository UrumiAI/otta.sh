/**
 * The order's presentation rules shared by `/orders/<id>` and the account's own
 * order page (`lib/order-view.ts`) — so the two pages cannot disagree about the
 * same order (QA U-5, U-13).
 *
 *  - the totals rows: "Not calculated" is decided by the plugin's
 *    `orderTotalsFlags`, never printed as $0.00;
 *  - the total's label: the domain's `orderTotalLabel` ("Paid" for every state
 *    the money was captured in, refunded included; "Total" otherwise);
 *  - the step tracker: Payment is "completed" only for an order that was paid.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCheckoutTotals, orderTotalLabel, orderTotalsFlags } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { orderProgress, orderSumRows } from "../src/lib/order-view.js";
import { SRC } from "./theme-views.js";

const BREAKDOWN = {
	currency: "USD",
	subtotalCents: 2400,
	discountCents: 0,
	shippingCents: 0,
	taxCents: 0,
	totalCents: 2400,
	appliedCouponCode: null,
};

describe("orderTotalLabel — the order pages use the domain's one rule", () => {
	test("both order pages take it from @otta-sh/plugin (the domain's), not a copy of their own", () => {
		for (const page of ["orders/[orderId].astro", "account/orders/[id].astro"]) {
			const source = readFileSync(path.join(SRC, "pages", page), "utf8");
			expect(source, page).toMatch(
				/import \{[^}]*\borderTotalLabel\b[^}]*\} from "@otta-sh\/plugin"/,
			);
		}
		expect(readFileSync(path.join(SRC, "lib/order-view.ts"), "utf8")).not.toMatch(
			/export function orderTotalLabel/,
		);
	});

	test("a refunded order's figure is what was Paid — the refund is said separately", () => {
		expect(orderTotalLabel("refunded")).toBe("Paid");
		expect(orderTotalLabel("shipped")).toBe("Paid");
		expect(orderTotalLabel("pending")).toBe("Total");
	});
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

	test("ADR-0031: a digital order taxed at the shop base address shows the tax it was charged", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN, subtotalCents: 5000, taxCents: 1000, totalCents: 6000 },
			{
				locale: "en",
				...orderTotalsFlags({ shippingZoneId: null, shippingMethodId: null, taxLocated: true }),
			},
		);
		const byLabel = new Map(orderSumRows(totals).map((row) => [row.label, row]));
		expect(byLabel.get("Tax")?.amount.label).toBe("$10.00");
		expect(byLabel.get("Tax")?.amount.money).not.toBeNull();
	});

	test("an applied coupon names itself on the discount row", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN, discountCents: 500, totalCents: 1900, appliedCouponCode: "SAVE5" },
			{ locale: "en", shippingSelected: false, taxZoneSelected: false },
		);
		// The code rides as its own field, so the label's uppercase styling can
		// never re-spell it: the merchant's stored spelling, as the emails print it
		// (QA round 2: "qa2admin2" read "QA2ADMIN2" on the order page).
		expect(orderSumRows(totals)[1]).toMatchObject({ label: "Discount", code: "SAVE5" });
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
