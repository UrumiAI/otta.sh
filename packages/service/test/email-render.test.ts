import { describe, expect, test } from "vitest";
import { renderEmail } from "../src/email/render.js";

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

// The cancelled template must carry WHY (admin-UX Increment 1, "cancel with
// reason") instead of the old reason-free "Your order has been cancelled." —
// and degrade gracefully when an order was cancelled without a reason (the
// bare transition path).

describe("renderEmail order-cancelled", () => {
	const base = {
		orderId: "ord-1",
		currency: "USD",
		totalCents: 1500,
		lines: [],
	};

	test("carries a human-readable reason label + detail when a cancellation is present", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: { reason: "out_of_stock", detail: "last unit sold on another channel" },
		});
		expect(rendered.text).toContain("Reason: the item being out of stock");
		expect(rendered.text).toContain("last unit sold on another channel");
		expect(rendered.html).toContain("the item being out of stock");
	});

	test("omits the detail suffix when none was recorded", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: { reason: "customer_request", detail: null },
		});
		expect(rendered.text).toContain("Reason: the customer requested it");
		expect(rendered.text).not.toContain(" — null");
	});

	test("degrades to the plain body when the order was cancelled without a reason", () => {
		const rendered = renderEmail("order-cancelled", base);
		expect(rendered.text).toContain("Your order has been cancelled.");
		expect(rendered.text).not.toContain("Reason:");
	});

	test("escapes HTML in the reason detail", () => {
		const rendered = renderEmail("order-cancelled", {
			...base,
			cancellation: { reason: "other", detail: "<b>x</b> & y" },
		});
		expect(rendered.html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
	});

	test("other order templates ignore cancellation data", () => {
		const rendered = renderEmail("order-processing", {
			...base,
			cancellation: { reason: "customer_request", detail: null },
		});
		expect(rendered.text).not.toContain("Reason:");
	});
});
