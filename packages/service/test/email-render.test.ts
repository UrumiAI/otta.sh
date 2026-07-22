import { describe, expect, test } from "vitest";
import { customerSafeCancellationCopy, renderEmail } from "../src/email/render.js";

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
