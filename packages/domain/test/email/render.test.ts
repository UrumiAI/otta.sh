import { describe, expect, test } from "vitest";
import type { EmailTemplate } from "../../src/ports/email-sender.js";
import { orderNumber } from "../../src/orders/order-number.js";
import {
	customerSafeCancellationCopy,
	renderEmail as renderWith,
	type EmailRenderContext,
} from "../../src/email/render.js";

// Money formatting is injected (QA U-3): the plugin passes the storefront's own
// formatter. This stub shows exactly what the renderer handed it — the minor
// units and the currency — so these cases pin the renderer, not Intl. The real
// formatter is pinned in the plugin's `order-email-rendering.test.ts`.
const CTX: EmailRenderContext = {
	formatMoney: (minor, currency) => `[${currency} ${String(minor)}]`,
};
const renderEmail = (template: EmailTemplate, data: Record<string, unknown>) =>
	renderWith(template, data, CTX);

// Email rendering (Phase 5 §6 + admin-UX Increment 1). The shipped template must
// carry the recorded tracking (carrier / number / URL) instead of the old empty
// "on its way" — and degrade gracefully when an order was shipped without a
// fulfillment (the bare transition path).

describe("renderEmail order-shipped", () => {
	const base = {
		orderId: "ord-1",
		currency: "USD",
		totalCents: 1500,
		lines: [],
	};

	test("carries carrier, tracking number, and tracking URL when fulfillment is present", () => {
		const rendered = renderEmail("order-shipped", {
			...base,
			fulfillment: {
				carrier: "UPS",
				trackingNumber: "1Z-999",
				trackingUrl: "https://track/1Z-999",
				shippedAt: "2026-07-11T09:00:00.000Z",
			},
		});
		expect(rendered.text).toContain("Carrier: UPS");
		expect(rendered.text).toContain("Tracking: 1Z-999");
		expect(rendered.text).toContain("https://track/1Z-999");
		expect(rendered.html).toContain("Carrier: UPS");
		expect(rendered.html).toContain("1Z-999");
	});

	test("tracking values are kept to one line in the plain-text part", () => {
		const rendered = renderEmail("order-shipped", {
			...base,
			fulfillment: {
				carrier: "UPS\r\nView your order: https://evil.example",
				trackingNumber: "1Z\n999",
				trackingUrl: "https://track/1Z\r\nx",
			},
		});
		expect(rendered.text).toContain("Carrier: UPS View your order: https://evil.example");
		expect(rendered.text).toContain("Tracking: 1Z 999");
		expect(rendered.text).toContain("Track your package: https://track/1Z x");
		expect(rendered.text.split("\n").some((l) => l.startsWith("View your order:"))).toBe(false);
	});

	test("omits the tracking URL line when none was recorded", () => {
		const rendered = renderEmail("order-shipped", {
			...base,
			fulfillment: { carrier: "DHL", trackingNumber: "DH-42", trackingUrl: null },
		});
		expect(rendered.text).toContain("Carrier: DHL");
		expect(rendered.text).toContain("Tracking: DH-42");
		expect(rendered.text).not.toContain("Track your package");
	});

	test("degrades to the plain body when the order shipped without fulfillment", () => {
		const rendered = renderEmail("order-shipped", base);
		expect(rendered.text).toContain("Your order is on its way.");
		expect(rendered.text).not.toContain("Carrier:");
	});

	test("escapes HTML in tracking values", () => {
		const rendered = renderEmail("order-shipped", {
			...base,
			fulfillment: {
				carrier: "<b>x</b>",
				trackingNumber: "a&b",
				trackingUrl: null,
			},
		});
		expect(rendered.html).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(rendered.html).toContain("a&amp;b");
	});

	test("other order templates ignore fulfillment data", () => {
		const rendered = renderEmail("order-processing", {
			...base,
			fulfillment: { carrier: "UPS", trackingNumber: "1Z-999", trackingUrl: null },
		});
		expect(rendered.text).not.toContain("Carrier:");
	});
});

// The cancelled template carries WHY only through the explicit CUSTOMER-SAFE
// allowlist (admin-UX Increment 1, "cancel with reason" + the PR #64 review
// blocker): safe reasons (customer_request, out_of_stock) render exactly their
// safe copy; sensitive reasons (fraud_suspected, pricing_error, other) render
// NO reason line at all; and the admin's free-text detail NEVER reaches the
// customer email for ANY reason value.

describe("renderEmail order-cancelled", () => {
	const base = {
		orderId: "ord-1",
		currency: "USD",
		totalCents: 1500,
		lines: [],
	};

	test("customer_request renders exactly its customer-safe copy", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: { reason: "customer_request", detail: null },
		});
		expect(rendered.text).toContain("Reason: at your request");
		expect(rendered.html).toContain("Reason: at your request");
	});

	test("out_of_stock renders exactly its customer-safe copy — never the raw enum value", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: { reason: "out_of_stock", detail: "last unit sold on another channel" },
		});
		expect(rendered.text).toContain("Reason: an item was unavailable");
		expect(rendered.html).toContain("Reason: an item was unavailable");
		expect(rendered.text).not.toContain("out_of_stock");
	});

	test.each(["fraud_suspected", "pricing_error", "other"])(
		"%s produces NO reason text in the customer email (generic body only)",
		(reason) => {
			const rendered = renderEmail("order-cancelled", {
				...base,
				cancellation: { reason, detail: "sensitive internal context" },
			});
			expect(rendered.text).toContain("Your order has been cancelled.");
			expect(rendered.text).not.toContain("Reason:");
			expect(rendered.html).not.toContain("Reason:");
			expect(rendered.text).not.toContain(reason);
			expect(rendered.html).not.toContain(reason);
			expect(rendered.text).not.toContain("fraud");
			expect(rendered.html).not.toContain("fraud");
		},
	);

	test.each(["customer_request", "fraud_suspected", "out_of_stock", "pricing_error", "other"])(
		"the admin detail text never reaches the customer email (reason: %s)",
		(reason) => {
			const detail = "ADMIN-ONLY chargeback context for cust-a";
			const rendered = renderEmail("order-cancelled", {
				...base,
				cancellation: { reason, detail },
			});
			expect(rendered.text).not.toContain(detail);
			expect(rendered.html).not.toContain(detail);
			expect(rendered.text).not.toContain("ADMIN-ONLY");
		},
	);

	test("an unrecognized reason value is treated as not customer-safe (no reason line)", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: { reason: "some_future_reason", detail: null },
		});
		expect(rendered.text).not.toContain("Reason:");
		expect(rendered.text).not.toContain("some_future_reason");
	});

	test("degrades to the plain body when the order was cancelled without a reason", () => {
		const rendered = renderEmail("order-cancelled", base);
		expect(rendered.text).toContain("Your order has been cancelled.");
		expect(rendered.text).not.toContain("Reason:");
	});

	test("other order templates ignore cancellation data", () => {
		const rendered = renderEmail("order-processing", {
			...base,
			cancellation: { reason: "customer_request", detail: null },
		});
		expect(rendered.text).not.toContain("Reason:");
	});
});

// QA T1-4: cancelling a paid order refunds it, and the buyer's email must say so —
// with the amount actually refunded — whatever the (possibly sensitive) reason was.
describe("renderEmail order-cancelled with a refund", () => {
	const base = { orderId: "ord-1", currency: "USD", totalCents: 2400, lines: [] };

	test("states the refund and its amount", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: {
				reason: "customer_request",
				detail: null,
				refund: { amountCents: 1800, currency: "USD" },
			},
		});
		expect(rendered.text).toContain(
			"A refund of [USD 1800] is on its way to your original payment method.",
		);
		expect(rendered.html).toContain("A refund of [USD 1800] is on its way");
		// The reason line still renders beside it.
		expect(rendered.text).toContain("Reason: at your request");
	});

	test("states the refund even when the reason is not customer-safe", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: {
				reason: "fraud_suspected",
				detail: "internal",
				refund: { amountCents: 2400, currency: "USD" },
			},
		});
		expect(rendered.text).toContain("A refund of [USD 2400] is on its way");
		expect(rendered.text).not.toContain("Reason:");
		expect(rendered.text).not.toContain("fraud");
	});

	test("says nothing about a refund when none was made", () => {
		for (const cancellation of [
			{ reason: "customer_request", detail: null, refund: null },
			{ reason: "customer_request", detail: null },
		]) {
			const rendered = renderEmail("order-cancelled", { ...base, cancellation });
			expect(rendered.text).not.toContain("refund");
		}
	});
});

// The mapping itself, pinned as the explicit allowlist the review asked for:
// exactly two customer-safe reasons; everything else — incl. every sensitive
// enum member and unknown values — is undefined (⇒ no reason line renders).
describe("customerSafeCancellationCopy", () => {
	test("safe reasons map to exactly their safe copy", () => {
		expect(customerSafeCancellationCopy("customer_request")).toBe("at your request");
		expect(customerSafeCancellationCopy("out_of_stock")).toBe("an item was unavailable");
	});

	test.each(["fraud_suspected", "pricing_error", "other", "anything_else", ""])(
		"%s is not customer-safe (undefined)",
		(reason) => {
			expect(customerSafeCancellationCopy(reason)).toBeUndefined();
		},
	);
});

// INC-C5 review (A8) — the money line. Minor units are INTEGERS, handed to the
// injected formatter untouched, and the sign is placed by the renderer — the
// formatter only ever sees a magnitude (a refund line carrying -550 once rendered
// as "-6.-50", which is not a price, in an email a customer reads).
describe("renderEmail hands the formatter integer minor units", () => {
	const base = { orderId: "ord-money", currency: "USD", lines: [] };

	test.each([
		[1500, "[USD 1500]"],
		[5, "[USD 5]"],
		[0, "[USD 0]"],
		[-550, "−[USD 550]"],
		[-5, "−[USD 5]"],
	])("%d minor units renders as %s", (totalCents, expected) => {
		expect(renderEmail("order-confirmation", { ...base, totalCents }).text).toContain(
			// No state in this data, so the page's label for an unpaid total.
			`Total: ${expected}`,
		);
	});

	test.each([10.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"%s is not an integer minor unit and renders NO amount rather than a wrong one",
		(totalCents) => {
			const rendered = renderEmail("order-confirmation", { ...base, totalCents });
			expect(rendered.text).not.toContain("USD");
		},
	);
});

// The sign-in email (issue #306). The link is a clickable ANCHOR — a bare URL in
// a paragraph is not clickable in every client — and both the href and the text
// are HTML-escaped: the URL is built from operator config and a token, and
// neither is markup. (Anchor + escaping adapted from #325 by @stephanedemotte.)
describe("renderEmail customer-login-link", () => {
	const loginUrl = 'https://shop.example/account/verify?challenge=c1&token=a"b<c>';

	test("the HTML carries the link as an escaped <a href>", () => {
		const rendered = renderEmail("customer-login-link", { loginUrl });
		const escaped = "https://shop.example/account/verify?challenge=c1&amp;token=a&quot;b&lt;c&gt;";
		// A BUTTON (QA2 U-3): a bold, padded, filled link — a bare blue line of
		// text under the intro read like a footnote. Inline styles only: mail
		// clients drop <style> blocks.
		expect(rendered.html).toMatch(
			new RegExp(
				`<a href="${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" style="[^"]*display:inline-block[^"]*background[^"]*">Sign in</a>`,
			),
		);
		// The copy-paste fallback is escaped the same way.
		expect(rendered.html).toContain(`into your browser:<br>${escaped}`);
		// Nothing from the URL survives unescaped into the markup.
		expect(rendered.html).not.toContain('a"b');
		expect(rendered.html).not.toContain("<c>");
	});

	test("the plain-text body carries the link verbatim", () => {
		expect(renderEmail("customer-login-link", { loginUrl }).text).toContain(loginUrl);
	});

	test("with no link it renders no anchor at all", () => {
		expect(renderEmail("customer-login-link", {}).html).not.toContain("<a ");
	});
});

// The buyer never sees the whole order id (a UUID names nothing they bought): every
// order email names the order by its products — `orderLabel` over the lines
// `buildOrderEmailData` already passes — and by its short number (`orderNumber`,
// ADR-0033), in the subject AND both bodies. The id stays in `data.orderId` for
// the dispatcher; only its first five characters are rendered.
describe("renderEmail names the order by its products, never its id", () => {
	const ORDER_ID = "0b6f1c2e-9a4d-4e57-8f1a-3c2d1e0f9a8b";
	const templates = [
		"order-confirmation",
		"order-processing",
		"order-shipped",
		"order-delivered",
		"order-completed",
		"order-cancelled",
		"order-refunded",
		"order-expired",
	] as const;
	const data = {
		orderId: ORDER_ID,
		currency: "USD",
		totalCents: 4500,
		lines: [
			{ sku: "TEE-M", title: "Otta Tee", quantity: 2, unitPriceCents: 1500 },
			{ sku: "MUG", title: "Otta Mug", quantity: 1, unitPriceCents: 1500 },
		],
	};

	test.each(templates)("%s: no order id in the subject, text or HTML", (template) => {
		const rendered = renderEmail(template, data);
		for (const part of [rendered.subject, rendered.text, rendered.html]) {
			expect(part).not.toContain(ORDER_ID);
		}
	});

	test.each(templates)("%s: the product label is in the subject, text and HTML", (template) => {
		const rendered = renderEmail(template, data);
		expect(rendered.subject).toContain("Otta Tee and 1 more");
		expect(rendered.text).toContain("Otta Tee and 1 more");
		expect(rendered.html).toContain("Otta Tee and 1 more");
	});

	test("a single line names its title and quantity", () => {
		const rendered = renderEmail("order-confirmation", {
			...data,
			lines: [{ sku: "TEE-M", title: "Otta Tee", quantity: 3, unitPriceCents: 1500 }],
		});
		expect(rendered.subject).toBe("Order confirmed #0B6F1 — Otta Tee × 3");
		expect(rendered.text).toContain("Order #0B6F1: Otta Tee × 3");
	});

	test("no lines (or no usable titles) falls back to 'Your order', still without the id", () => {
		const rendered = renderEmail("order-confirmation", { ...data, lines: [] });
		expect(rendered.subject).toBe("Order confirmed #0B6F1 — Your order");
		expect(rendered.text).not.toContain(ORDER_ID);
		const malformed = renderEmail("order-confirmation", { ...data, lines: "not-an-array" });
		expect(malformed.subject).toBe("Order confirmed #0B6F1 — Your order");
	});

	test("a title with CR/LF or control characters never breaks the subject onto two lines", () => {
		const rendered = renderEmail("order-confirmation", {
			...data,
			lines: [{ sku: "X", title: "Otta\r\nTee\u0000", quantity: 1, unitPriceCents: 100 }],
		});
		expect(rendered.subject).toBe("Order confirmed #0B6F1 — Otta Tee");
		// oxlint-disable-next-line no-control-regex -- asserting control characters are absent is the point
		expect(rendered.subject).not.toMatch(/[\u0000-\u001f\u007f]/);
	});

	test("a 500-character title is clamped in the subject", () => {
		const rendered = renderEmail("order-confirmation", {
			...data,
			lines: [{ sku: "X", title: "y".repeat(500), quantity: 1, unitPriceCents: 100 }],
		});
		expect(rendered.subject.length).toBeLessThan(120);
		expect(rendered.subject).toMatch(/y…$/);
	});

	test("the label is HTML-escaped in the HTML body", () => {
		const rendered = renderEmail("order-confirmation", {
			...data,
			lines: [{ sku: "X", title: "<b>Tee</b> & Co", quantity: 1, unitPriceCents: 100 }],
		});
		expect(rendered.html).toContain("&lt;b&gt;Tee&lt;/b&gt; &amp; Co");
		expect(rendered.html).not.toContain("<b>Tee</b>");
		expect(rendered.text).toContain("<b>Tee</b> & Co");
	});
});

// QA T1-6: a refund email states the amount REFUNDED — not the order total — and
// every refund email states it the same way (`Refunded: X`, the notice path).
describe("renderEmail refund emails", () => {
	const base = { orderId: "ord-1", currency: "USD", totalCents: 2400, lines: [] };

	test("a refund-issued email states its own amount, neutral about how much and how", () => {
		const rendered = renderEmail("order-refund-issued", {
			...base,
			noticeAmountCents: 600,
			noticeCurrency: "USD",
		});
		// Named by its number and products (ADR-0033); with no lines, "Your order".
		expect(rendered.subject).toBe("Refund issued #ORD-1 — Your order");
		// Neutral: it also announces a FULL refund on an order that cannot flip to
		// refunded (a cancellation that lost the race to a shipment).
		expect(rendered.text).toContain("We've issued a refund for your order.");
		expect(rendered.text).not.toContain("partial");
		expect(rendered.text).toContain("Refunded: [USD 600]");
		// The refunded money is THE figure; the order's total appears only in the
		// summary, under its own name — never as a bare "Total:" to misread.
		expect(rendered.text).not.toMatch(/^Total:/mu);
		expect(rendered.text.indexOf("Refunded:")).toBeLessThan(rendered.text.indexOf("Order total:"));
		expect(rendered.text).not.toContain("original payment method");
	});

	test("the refunded state email states the money refunded the same way", () => {
		const rendered = renderEmail("order-refunded", {
			...base,
			state: "refunded",
			noticeAmountCents: 2400,
			noticeCurrency: "USD",
		});
		expect(rendered.text).toContain("Your order has been refunded.");
		expect(rendered.text).toContain("Refunded: [USD 2400]");
	});
});

// The order NUMBER (ADR-0033): "#" + the id's first five characters, upper-cased —
// the same `orderNumber` the storefront and the admin console print, so a buyer
// quoting it to the merchant quotes what the console shows.
describe("renderEmail carries the order number", () => {
	const ORDER_ID = "3f9a2b1c-7d4e-4a5b-9c8d-0123456789ab";
	const templates = [
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
	] as const;
	const data = {
		orderId: ORDER_ID,
		state: "paid",
		currency: "USD",
		totalCents: 1500,
		noticeAmountCents: 1500,
		noticeCurrency: "USD",
		lines: [{ sku: "TEE-M", title: "Otta Tee", quantity: 1, unitPriceCents: 1500 }],
	};

	test.each(templates)("%s: the number is in the subject, text and HTML", (template) => {
		const rendered = renderEmail(template, data);
		expect(rendered.subject).toContain("#3F9A2 — Otta Tee");
		expect(rendered.text).toContain("Order #3F9A2: Otta Tee");
		expect(rendered.html).toContain("<strong>Order #3F9A2</strong><br>Otta Tee");
		for (const part of [rendered.subject, rendered.text, rendered.html]) {
			expect(part).not.toContain(ORDER_ID);
		}
	});

	test("the confirmation subject reads template, number, products", () => {
		expect(renderEmail("order-confirmation", data).subject).toBe(
			"Order confirmed #3F9A2 — Otta Tee",
		);
	});

	test("data without an order id still renders, named by its products alone", () => {
		const { orderId: _omit, ...rest } = data;
		const rendered = renderEmail("order-confirmation", rest);
		expect(rendered.subject).toBe("Order confirmed — Otta Tee");
		expect(rendered.text).toContain("Order: Otta Tee");
		expect(rendered.text).not.toContain("#");
		const notAString = renderEmail("order-confirmation", { ...data, orderId: 42 });
		expect(notAString.subject).toBe("Order confirmed — Otta Tee");
	});

	test("a hostile id cannot break the subject or inject markup", () => {
		const rendered = renderEmail("order-confirmation", { ...data, orderId: "<b>\r\nX" });
		// oxlint-disable-next-line no-control-regex -- asserting control characters are absent is the point
		expect(rendered.subject).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(rendered.html).not.toContain("<b>");
	});

	test("the number is orderNumber of the RAW id — the same as every other surface", () => {
		for (const id of [ORDER_ID, crypto.randomUUID(), "ord-1"]) {
			const rendered = renderEmail("order-confirmation", { ...data, orderId: id });
			expect(rendered.subject).toBe(`Order confirmed ${orderNumber(id)} — Otta Tee`);
		}
	});

	test("the sign-in email has no order number", () => {
		const rendered = renderEmail("customer-login-link", { loginUrl: "https://shop.test/x" });
		expect(rendered.subject).not.toContain("#");
	});
});
