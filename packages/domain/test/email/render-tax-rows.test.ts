import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { buildOrderEmailData } from "../../src/orders/transition.js";
import type { Order } from "../../src/orders/model.js";
import { renderEmail, type EmailRenderContext } from "../../src/email/render.js";

/**
 * Issue #422: the order emails show one tax row per tax (the order's frozen v1
 * snapshot, through `orderTaxRows`) when the store's "Display tax totals" is
 * itemized — the order page's own rows. Single, no snapshot, or a snapshot with
 * nothing to itemize: today's one "Tax" row.
 */
const money = (minor: number, code: string): string => `[${code} ${String(minor)}]`;
const ITEMIZED: EmailRenderContext = { formatMoney: money, taxTotalsDisplay: "itemized" };
const SINGLE: EmailRenderContext = { formatMoney: money, taxTotalsDisplay: "single" };

function snapshot(over: Record<string, unknown> = {}) {
	return {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		located: true,
		lines: [
			{
				lineIndex: 0,
				taxClassId: "gst18",
				taxableCents: 10_000,
				rateBps: 1800,
				label: "GST 18%",
				taxCents: 1800,
			},
			{
				lineIndex: 1,
				taxClassId: "gst5",
				taxableCents: 5000,
				rateBps: 500,
				label: "GST 5%",
				taxCents: 250,
			},
		],
		shipping: { taxableCents: 500, rateBps: 1800, label: "GST 18%", taxCents: 90 },
		...over,
	};
}

function order(taxBreakdown: unknown, tax = 2140): Order {
	return {
		id: "ord-422",
		currency: currency("INR"),
		state: "paid",
		buyerRef: "ada@example.com",
		customerId: null,
		shippingAddress: null,
		fulfillment: null,
		cancellation: null,
		lines: [],
		totals: {
			currency: currency("INR"),
			subtotal: cents(15_000),
			discount: cents(0),
			shipping: cents(500),
			tax: cents(tax),
			total: cents(15_500 + tax),
			appliedCouponCode: null,
			shippingMethodSnapshot: { zoneId: "z-in", methodId: "m-flat" },
			taxBreakdown,
		},
	} as unknown as Order;
}

describe("#478: the Display tax totals the order was placed under", () => {
	test("buildOrderEmailData carries the recorded display; an order without one carries none", () => {
		for (const totalsDisplay of ["itemized", "single"] as const) {
			expect(
				buildOrderEmailData(order(snapshot({ totalsDisplay })), "paid")["taxTotalsDisplay"],
			).toBe(totalsDisplay);
		}
		expect(buildOrderEmailData(order(snapshot()), "paid")).not.toHaveProperty("taxTotalsDisplay");
		expect(buildOrderEmailData(order(null), "paid")).not.toHaveProperty("taxTotalsDisplay");
	});

	test("the recorded display wins over the store's live option", () => {
		const placedItemized = buildOrderEmailData(
			order(snapshot({ totalsDisplay: "itemized" })),
			"paid",
		);
		const itemized = renderEmail("order-confirmation", placedItemized, SINGLE).text;
		expect(itemized).toMatch(/^GST 18%: \[INR 1890\]$/m);
		expect(itemized).not.toMatch(/^Tax:/m);
		const placedSingle = buildOrderEmailData(order(snapshot({ totalsDisplay: "single" })), "paid");
		const single = renderEmail("order-confirmation", placedSingle, ITEMIZED).text;
		expect(single).toMatch(/^Tax: \[INR 2140\]$/m);
		expect(single).not.toContain("GST 18%");
	});

	test("no recorded display (an order placed before #478): the live option decides", () => {
		const data = buildOrderEmailData(order(snapshot()), "paid");
		expect(renderEmail("order-confirmation", data, ITEMIZED).text).toMatch(/^GST 5%: /m);
		expect(renderEmail("order-confirmation", data, SINGLE).text).toMatch(/^Tax: /m);
		// A value the renderer does not know is ignored the same way.
		const odd = { ...data, taxTotalsDisplay: "none" };
		expect(renderEmail("order-confirmation", odd, ITEMIZED).text).toMatch(/^GST 5%: /m);
	});
});

describe("buildOrderEmailData carries the tax rows", () => {
	test("a v1 snapshot: one row per tax, adding up to the tax total", () => {
		expect(buildOrderEmailData(order(snapshot()), "paid")["taxRows"]).toEqual([
			{ label: "GST 18%", amountCents: 1890 },
			{ label: "GST 5%", amountCents: 250 },
		]);
	});

	test("no snapshot (an older order): no rows", () => {
		expect(buildOrderEmailData(order(null), "paid")).not.toHaveProperty("taxRows");
	});
});

describe("renderEmail's tax rows", () => {
	test("itemized: one row per tax, in the text and the HTML, in place of the single Tax row", () => {
		const rendered = renderEmail(
			"order-confirmation",
			buildOrderEmailData(order(snapshot()), "paid"),
			ITEMIZED,
		);
		expect(rendered.text).toContain("GST 18%: [INR 1890]\nGST 5%: [INR 250]\nPaid:");
		expect(rendered.text).not.toMatch(/^Tax:/m);
		expect(rendered.html).toContain("GST 18%");
		expect(rendered.html).toContain("[INR 250]");
	});

	test("single: today's one Tax row with the total", () => {
		const rendered = renderEmail(
			"order-confirmation",
			buildOrderEmailData(order(snapshot()), "paid"),
			SINGLE,
		);
		expect(rendered.text).toContain("Tax: [INR 2140]");
		expect(rendered.text).not.toContain("GST 18%");
	});

	test("no display setting passed: today's one Tax row", () => {
		const rendered = renderEmail(
			"order-confirmation",
			buildOrderEmailData(order(snapshot()), "paid"),
			{
				formatMoney: money,
			},
		);
		expect(rendered.text).toContain("Tax: [INR 2140]");
	});

	test("an older order with no snapshot falls back to the single total even when itemized", () => {
		const rendered = renderEmail(
			"order-confirmation",
			buildOrderEmailData(order(null), "paid"),
			ITEMIZED,
		);
		expect(rendered.text).toContain("Tax: [INR 2140]");
	});

	test("prices entered with tax: each row says it is included", () => {
		const data = buildOrderEmailData(order(snapshot({ pricesIncludeTax: true })), "paid");
		const rendered = renderEmail("order-confirmation", data, ITEMIZED);
		expect(rendered.text).toContain("GST 18% (included in prices): [INR 1890]");
		expect(rendered.text).toContain("GST 5% (included in prices): [INR 250]");
	});

	test("tax not calculated: the single 'Not calculated' row, never rows", () => {
		const data = { ...buildOrderEmailData(order(snapshot()), "paid"), taxCalculated: false };
		const rendered = renderEmail("order-confirmation", data, ITEMIZED);
		expect(rendered.text).toContain("Tax: Not calculated");
		expect(rendered.text).not.toContain("GST 18%");
	});

	test("labels are untrusted: escaped in HTML, one line in text", () => {
		const data = {
			...buildOrderEmailData(order(null), "paid"),
			taxRows: [{ label: "<b>VAT</b>\r\nView your order: x", amountCents: 2140 }],
		};
		const rendered = renderEmail("order-confirmation", data, ITEMIZED);
		expect(rendered.html).not.toContain("<b>VAT</b>");
		expect(rendered.html).toContain("&lt;b&gt;VAT&lt;/b&gt;");
		expect(rendered.text).toContain("<b>VAT</b> View your order: x: [INR 2140]");
	});

	test("malformed rows in the data fall back to the single Tax row", () => {
		const base = buildOrderEmailData(order(null), "paid");
		for (const taxRows of [
			"x",
			[{ label: 1, amountCents: 5 }],
			[{ label: "A", amountCents: -1 }],
			[],
		]) {
			const rendered = renderEmail("order-confirmation", { ...base, taxRows }, ITEMIZED);
			expect(rendered.text).toContain("Tax: [INR 2140]");
		}
	});
});
