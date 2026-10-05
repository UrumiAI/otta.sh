import { describe, expect, test } from "vitest";
import {
	EMAIL_NOT_CALCULATED_LABEL,
	renderEmail,
	type EmailRenderContext,
} from "../../src/email/render.js";
import type { EmailTemplate } from "../../src/ports/email-sender.js";

// QA U-3: order emails were nearly empty — no lines, no totals breakdown, no
// address, no link. Every order email (each state email and both notices) now
// carries what the order RECORDED: its line snapshot, its totals, its ship-to
// and a link to its page.
//
// Money formatting is injected (`EmailRenderContext.formatMoney`): formatting is
// presentation, and the plugin passes the storefront's own formatter. These
// tests use a stub that shows exactly what it was handed — minor units and the
// currency — so they pin that the renderer passes integers through untouched.
// The real formatter ("$100.00", "₹1,234.50") is pinned end-to-end in the
// plugin's `order-email-rendering.test.ts`.

const stubMoney = (minor: number, currency: string): string => `[${currency} ${String(minor)}]`;
const ORDER_ID = "0b6f1c2e-9a4d-4e57-8f1a-3c2d1e0f9a8b";
const ORDER_URL = `https://shop.example/orders/${ORDER_ID}`;
const ctx: EmailRenderContext = { formatMoney: stubMoney, orderPageUrl: ORDER_URL };

const ORDER_TEMPLATES: EmailTemplate[] = [
	"order-confirmation",
	"order-processing",
	"order-shipped",
	"order-delivered",
	"order-completed",
	"order-cancelled",
	"order-refunded",
	"order-expired",
	"order-late-payment-refunded",
	"order-refund-issued",
];

const address = {
	name: "Ada Lovelace",
	line1: "1 Analytical Way",
	line2: "Flat 2",
	city: "London",
	region: "Greater London",
	postalCode: "EC1A 1AA",
	country: "GB",
};

/** What `buildOrderEmailData` produces for a two-line order with a coupon and
 *  calculated shipping and tax. */
const full = {
	orderId: ORDER_ID,
	state: "paid",
	currency: "USD",
	subtotalCents: 4500,
	discountCents: 500,
	shippingCents: 700,
	taxCents: 320,
	totalCents: 5020,
	appliedCouponCode: "SAVE5",
	shippingCalculated: true,
	taxCalculated: true,
	lines: [
		{ sku: "TEE-M", title: "Otta Tee", quantity: 2, unitPriceCents: 1500 },
		{ sku: "MUG", title: "Otta Mug", quantity: 1, unitPriceCents: 1500 },
	],
	shippingAddress: address,
};

describe.each(ORDER_TEMPLATES)("%s carries the order's details", (template) => {
	const rendered = renderEmail(template, full, ctx);

	test("each line: product name, quantity and line price (unit × qty), in both parts", () => {
		expect(rendered.text).toContain("Otta Tee × 2 — [USD 3000]");
		expect(rendered.text).toContain("Otta Mug × 1 — [USD 1500]");
		expect(rendered.html).toContain("Otta Tee");
		expect(rendered.html).toContain("[USD 3000]");
		expect(rendered.html).toContain("[USD 1500]");
		// The SKU is an internal code: the line is named by its product.
		expect(rendered.text).not.toContain("TEE-M");
	});

	test("subtotal, discount with its coupon code, shipping, tax and total — the order page's rows", () => {
		// The order page's labels and sign: "Discount · CODE", the amount unsigned,
		// and the total "Paid" on a paid order (`orderTotalLabel`).
		expect(rendered.text).toContain("Subtotal: [USD 4500]");
		expect(rendered.text).toContain("Discount · SAVE5: [USD 500]");
		expect(rendered.text).toContain("Shipping: [USD 700]");
		expect(rendered.text).toContain("Tax: [USD 320]");
		expect(rendered.text).toContain("Paid: [USD 5020]");
		expect(rendered.html).toContain("Discount · SAVE5");
		expect(rendered.html).toContain("[USD 5020]");
	});

	test("the store's sign-off, when the store has a name", () => {
		const signed = renderEmail(template, full, { ...ctx, storeName: "Goa <Coffee>\r\nCo" });
		expect(signed.text.endsWith("— Goa <Coffee> Co")).toBe(true);
		expect(signed.html).toContain("— Goa &lt;Coffee&gt; Co");
		expect(signed.html).not.toContain("<Coffee>");
		// No name, no sign-off line.
		expect(rendered.text).not.toMatch(/\n— /u);
	});

	test("the HTML part declares its language", () => {
		const withLocale = renderEmail(template, full, { ...ctx, locale: "en" });
		expect(withLocale.html.startsWith('<div lang="en">')).toBe(true);
		expect(withLocale.html.endsWith("</div>")).toBe(true);
	});

	test("a link to the order page: an anchor in HTML, the URL in plain text", () => {
		expect(rendered.text).toContain(`View your order: ${ORDER_URL}`);
		expect(rendered.html).toContain(`<a href="${ORDER_URL}">View your order</a>`);
	});

	test("never the order id outside the link", () => {
		const withoutLink = (s: string) => s.replaceAll(ORDER_URL, "");
		expect(rendered.subject).not.toContain(ORDER_ID);
		expect(withoutLink(rendered.text)).not.toContain(ORDER_ID);
		expect(withoutLink(rendered.html)).not.toContain(ORDER_ID);
	});
});

// The ship-to is shown only where a delivery is still live. On an expired,
// cancelled or refunded order nothing is going to that address, and printing it
// reads like a promise that something is.
const DELIVERY_TEMPLATES: EmailTemplate[] = [
	"order-confirmation",
	"order-processing",
	"order-shipped",
	"order-delivered",
];
const NO_DELIVERY_TEMPLATES = ORDER_TEMPLATES.filter((t) => !DELIVERY_TEMPLATES.includes(t));

describe("the delivery address", () => {
	test.each(DELIVERY_TEMPLATES)("%s shows it", (template) => {
		const rendered = renderEmail(template, full, ctx);
		expect(rendered.text).toContain(
			"Delivery address:\nAda Lovelace\n1 Analytical Way\nFlat 2\nLondon, Greater London EC1A 1AA\nGB",
		);
		expect(rendered.html).toContain("1 Analytical Way");
	});

	test.each(NO_DELIVERY_TEMPLATES)("%s does not", (template) => {
		const rendered = renderEmail(template, full, ctx);
		expect(rendered.text).not.toContain("Delivery address");
		expect(rendered.text).not.toContain("1 Analytical Way");
		expect(rendered.html).not.toContain("1 Analytical Way");
	});

	test("the split covers every order template", () => {
		expect(NO_DELIVERY_TEMPLATES.toSorted()).toEqual(
			[
				"order-cancelled",
				"order-completed",
				"order-expired",
				"order-late-payment-refunded",
				"order-refund-issued",
				"order-refunded",
			].toSorted(),
		);
	});
});

describe("absent totals components", () => {
	const bare = {
		...full,
		discountCents: 0,
		shippingCents: 0,
		taxCents: 0,
		totalCents: 4500,
		appliedCouponCode: null,
		shippingCalculated: false,
		taxCalculated: false,
	};

	test("uncalculated shipping and tax say 'Not calculated', never a zero amount", () => {
		const rendered = renderEmail("order-confirmation", bare, ctx);
		expect(rendered.text).toContain(`Shipping: ${EMAIL_NOT_CALCULATED_LABEL}`);
		expect(rendered.text).toContain(`Tax: ${EMAIL_NOT_CALCULATED_LABEL}`);
		expect(rendered.text).not.toContain("[USD 0]");
		expect(rendered.html).toContain(EMAIL_NOT_CALCULATED_LABEL);
		expect(EMAIL_NOT_CALCULATED_LABEL).toBe("Not calculated");
	});

	test("a CALCULATED zero is money — free shipping the store priced is a real figure", () => {
		const rendered = renderEmail(
			"order-confirmation",
			{ ...bare, shippingCalculated: true, taxCalculated: true },
			ctx,
		);
		expect(rendered.text).toContain("Shipping: [USD 0]");
		expect(rendered.text).toContain("Tax: [USD 0]");
	});

	test("no coupon and no discount: the page's 'No coupon applied'", () => {
		const rendered = renderEmail("order-confirmation", bare, ctx);
		expect(rendered.text).toContain("Discount: No coupon applied");
		expect(rendered.html).toContain("No coupon applied");
	});

	test("a coupon that took nothing off is a real zero, as on the page", () => {
		const rendered = renderEmail("order-confirmation", { ...bare, appliedCouponCode: "ZERO" }, ctx);
		expect(rendered.text).toContain("Discount · ZERO: [USD 0]");
	});

	test("a discount with no coupon code is still stated", () => {
		const rendered = renderEmail("order-confirmation", { ...full, appliedCouponCode: null }, ctx);
		expect(rendered.text).toContain("Discount: [USD 500]");
	});

	test("an uncalculated flag wins over a stray amount, exactly as on the order page", () => {
		const rendered = renderEmail(
			"order-confirmation",
			{ ...full, shippingCalculated: false, taxCalculated: false },
			ctx,
		);
		expect(rendered.text).toContain(`Shipping: ${EMAIL_NOT_CALCULATED_LABEL}`);
		expect(rendered.text).toContain(`Tax: ${EMAIL_NOT_CALCULATED_LABEL}`);
	});

	// The total's label is the domain's `orderTotalLabel`, shared with the order
	// pages: "Paid" for every state an order reaches only after its payment was
	// captured, "Total" otherwise — so the email and the page cannot disagree.
	test.each([
		["order-processing", "processing"],
		["order-shipped", "shipped"],
		["order-delivered", "delivered"],
		["order-completed", "completed"],
	] as const)("%s: a captured order's total reads 'Paid', as on the page", (template, state) => {
		const rendered = renderEmail(template, { ...full, state }, ctx);
		expect(rendered.text).toContain("Paid: [USD 5020]");
		expect(rendered.text).not.toMatch(/^Total:/mu);
	});

	test.each([
		["order-expired", "expired"],
		["order-cancelled", "cancelled"],
		["order-confirmation", "pending"],
	] as const)("%s: an order whose payment was never captured reads 'Total'", (template, state) => {
		const rendered = renderEmail(template, { ...full, state }, ctx);
		expect(rendered.text).toContain("Total: [USD 5020]");
		expect(rendered.text).not.toContain("Paid:");
	});

	test("a refunded order with no Refunded figure still says it was paid — the refund is said separately", () => {
		const rendered = renderEmail("order-refunded", { ...full, state: "refunded" }, ctx);
		expect(rendered.text).toContain("Paid: [USD 5020]");
		expect(rendered.text).not.toMatch(/^Total:/mu);
	});

	test("a line whose title is blank still shows, as 'Item'", () => {
		const rendered = renderEmail(
			"order-confirmation",
			{
				...full,
				lines: [
					{ sku: "X", title: "  ", quantity: 2, unitPriceCents: 100 },
					{ sku: "Y", title: null, quantity: 1, unitPriceCents: 300 },
				],
			},
			ctx,
		);
		expect(rendered.text).toContain("Item × 2 — [USD 200]");
		expect(rendered.text).toContain("Item × 1 — [USD 300]");
	});

	test("no ship-to on file: no address block", () => {
		const rendered = renderEmail("order-confirmation", { ...full, shippingAddress: null }, ctx);
		expect(rendered.text).not.toContain("Delivery address");
		expect(rendered.html).not.toContain("Delivery address");
	});

	test("an address without line2 or region leaves no blank line or dangling comma", () => {
		const rendered = renderEmail(
			"order-confirmation",
			{ ...full, shippingAddress: { ...address, line2: null, region: null } },
			ctx,
		);
		expect(rendered.text).toContain(
			"Delivery address:\nAda Lovelace\n1 Analytical Way\nLondon EC1A 1AA\nGB",
		);
	});

	test("no order page URL configured: no link, and nothing that looks like one", () => {
		const rendered = renderEmail("order-confirmation", full, { formatMoney: stubMoney });
		expect(rendered.text).not.toContain("View your order");
		expect(rendered.html).not.toContain("<a ");
	});

	test("an amount the formatter cannot format drops that row rather than printing a wrong one", () => {
		const rendered = renderEmail("order-confirmation", { ...full, subtotalCents: 10.5 }, ctx);
		expect(rendered.text).not.toContain("Subtotal");
		expect(rendered.text).toContain("Paid: [USD 5020]");
	});
});

describe("refund emails keep their own figure first, then the order", () => {
	test("refund-issued: 'Refunded' is the refunded money; the order total is labelled as such", () => {
		const rendered = renderEmail(
			"order-refund-issued",
			{ ...full, noticeAmountCents: 600, noticeCurrency: "USD" },
			ctx,
		);
		const refunded = rendered.text.indexOf("Refunded: [USD 600]");
		const orderTotal = rendered.text.indexOf("Order total: [USD 5020]");
		expect(refunded).toBeGreaterThan(-1);
		expect(orderTotal).toBeGreaterThan(refunded);
	});

	test("the refunded state email that leads with 'Refunded: X' keeps 'Order total', never 'Paid'", () => {
		const rendered = renderEmail(
			"order-refunded",
			{ ...full, state: "refunded", noticeAmountCents: 5020, noticeCurrency: "USD" },
			ctx,
		);
		expect(rendered.text).toContain("Refunded: [USD 5020]");
		expect(rendered.text).toContain("Order total: [USD 5020]");
		expect(rendered.text).not.toContain("Paid:");
	});

	test("the cancelled-with-refund line is kept, formatted by the same formatter", () => {
		const rendered = renderEmail(
			"order-cancelled",
			{
				...full,
				cancellation: {
					reason: "customer_request",
					refund: { amountCents: 5020, currency: "USD" },
				},
			},
			ctx,
		);
		expect(rendered.text).toContain(
			"A refund of [USD 5020] is on its way to your original payment method.",
		);
		expect(rendered.text).toContain("Otta Tee × 2 — [USD 3000]");
	});
});

describe("user input is escaped in HTML and kept to one line in text", () => {
	const hostile = {
		...full,
		appliedCouponCode: '"><img src=x onerror=alert(1)>',
		lines: [
			{ sku: "X", title: "<script>alert(1)</script>", quantity: 1, unitPriceCents: 100 },
			{ sku: "Y", title: "Mug\r\nOrder total: $0.00", quantity: 1, unitPriceCents: 100 },
		],
		shippingAddress: {
			...address,
			name: '<b onmouseover="x">Eve</b>',
			line1: "1 Main St\n\nView your order: https://evil.example",
			city: "A & B",
		},
	};
	const rendered = renderEmail("order-confirmation", hostile, ctx);

	test("no tag from a title, a coupon code or an address survives into the HTML", () => {
		expect(rendered.html).not.toContain("<script>");
		expect(rendered.html).not.toContain("<img");
		expect(rendered.html).not.toContain("<b ");
		expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(rendered.html).toContain("&lt;b onmouseover=&quot;x&quot;&gt;Eve&lt;/b&gt;");
		expect(rendered.html).toContain("A &amp; B");
		// The only anchor is ours.
		expect(rendered.html.match(/<a /g)).toHaveLength(1);
	});

	test("a CR/LF in a title or address cannot forge a line in the plain-text part", () => {
		expect(rendered.text).toContain("Mug Order total: $0.00 × 1 — [USD 100]");
		expect(rendered.text.split("\n").filter((l) => l.startsWith("Paid:"))).toHaveLength(1);
		expect(rendered.text).toContain("1 Main St View your order: https://evil.example");
		expect(rendered.text.split("\n").filter((l) => l.startsWith("View your order:"))).toEqual([
			`View your order: ${ORDER_URL}`,
		]);
	});

	test("the formatter's output and the order URL are escaped too", () => {
		const odd = renderEmail("order-confirmation", full, {
			formatMoney: () => "<1>",
			orderPageUrl: 'https://shop.example/orders/a"b',
		});
		expect(odd.html).not.toContain("<1>");
		expect(odd.html).toContain('href="https://shop.example/orders/a&quot;b"');
	});
});

// The sign-in email (QA U-3): it names the store, gives the link a clear label
// rather than showing a raw URL alone (the URL stays as the plain-text and
// copy-paste fallback), and states the real expiry.
describe("customer-login-link copy", () => {
	const loginUrl = "https://shop.example/account/verify?challenge=c1&token=t1";
	const data = { loginUrl, expiresInMinutes: 15 };

	test("names the store in the subject and both parts", () => {
		const rendered = renderEmail("customer-login-link", data, {
			formatMoney: stubMoney,
			storeName: "Goa Coffee",
		});
		expect(rendered.subject).toBe("Sign in to Goa Coffee");
		expect(rendered.text).toContain("Goa Coffee");
		expect(rendered.html).toContain("Goa Coffee");
	});

	test("a labelled link in HTML, and the URL as a copy-paste fallback in both parts", () => {
		const rendered = renderEmail("customer-login-link", data, {
			formatMoney: stubMoney,
			storeName: "Goa Coffee",
		});
		const href = "https://shop.example/account/verify?challenge=c1&amp;token=t1";
		expect(rendered.html).toContain(`<a href="${href}">Sign in to Goa Coffee</a>`);
		expect(rendered.html).toContain(`copy this link into your browser:<br>${href}`);
		expect(rendered.text).toContain(loginUrl);
	});

	test("states the true expiry, never 'shortly'", () => {
		const rendered = renderEmail("customer-login-link", data, { formatMoney: stubMoney });
		expect(rendered.text).toContain("expires in 15 minutes");
		expect(rendered.html).toContain("expires in 15 minutes");
		expect(rendered.text).not.toContain("shortly");
		expect(
			renderEmail("customer-login-link", { loginUrl, expiresInMinutes: 1 }, ctx).text,
		).toContain("expires in 1 minute.");
	});

	test("with no store name configured it still reads naturally", () => {
		const rendered = renderEmail("customer-login-link", data, { formatMoney: stubMoney });
		expect(rendered.subject).toBe("Your sign-in link");
		expect(rendered.html).toContain(">Sign in</a>");
	});

	test("the store name is escaped and kept to one line", () => {
		const rendered = renderEmail("customer-login-link", data, {
			formatMoney: stubMoney,
			storeName: "<i>Shop</i>\r\nBcc: x",
		});
		expect(rendered.subject).toBe("Sign in to <i>Shop</i> Bcc: x");
		expect(rendered.html).not.toContain("<i>");
		expect(rendered.html).toContain("&lt;i&gt;Shop&lt;/i&gt;");
	});
});
