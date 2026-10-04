/**
 * The confirmation page's state stamp — what the order page is willing to say.
 *
 * Pinned here because one sentence on it was a lie: an EXPIRED order always said
 * "Nothing was charged", including when a payment arrived after the hold lapsed
 * and Stripe captured it. The sentence now follows the order's `latePayment`
 * status, which the plugin derives from the payments and refunds ledgers.
 */
import { describe, expect, test } from "vitest";
import { orderStamp } from "../src/lib/order-stamp.js";

const base = {
	returnedFromStripe: false,
	holdLapsed: false,
	latePayment: "none",
	polling: false,
} as const;

describe("orderStamp — expired and cancelled orders", () => {
	test("expired with nothing captured keeps 'Nothing was charged'", () => {
		const stamp = orderStamp({ ...base, state: "expired" });
		expect(stamp?.headline).toBe("This order expired.");
		expect(stamp?.body).toBe(
			"Payment didn't complete in time, so the items went back on sale. Nothing was charged.",
		);
	});

	test("expired with a late payment refunded says so — and never 'Nothing was charged'", () => {
		const stamp = orderStamp({ ...base, state: "expired", latePayment: "refunded" });
		expect(stamp?.headline).toBe("This order expired.");
		expect(stamp?.body).toContain(
			"A payment arrived after this order expired, so we've refunded it — it can take 5–10 days to appear.",
		);
		expect(stamp?.body).not.toContain("Nothing was charged");
	});

	test("expired with a late payment not yet refunded never claims nothing was charged either", () => {
		const stamp = orderStamp({ ...base, state: "expired", latePayment: "refund_pending" });
		expect(stamp?.body).toContain("A payment arrived after this order expired");
		expect(stamp?.body).not.toContain("Nothing was charged");
		expect(stamp?.body).not.toContain("we've refunded it");
		// The refund may be a person's job (a gateway that cannot refund, a definite
		// refusal) — so the page promises THAT it will be refunded, never how fast or
		// by whom.
		expect(stamp?.body).toBe(
			"Payment didn't complete in time, so the items went back on sale. A payment arrived after this order expired. It will be refunded — once it is, it can take 5–10 days to appear.",
		);
	});

	test("cancelled names the cancellation, not an expiry", () => {
		expect(orderStamp({ ...base, state: "cancelled" })).toEqual({
			headline: "This order was cancelled.",
			body: null,
		});
		const refunded = orderStamp({ ...base, state: "cancelled", latePayment: "refunded" });
		expect(refunded?.body).toBe(
			"A payment arrived after this order was cancelled, so we've refunded it — it can take 5–10 days to appear.",
		);
	});
});

describe("orderStamp — pending orders", () => {
	test("awaiting payment, or confirming after Stripe's redirect", () => {
		expect(orderStamp({ ...base, state: "pending" })?.headline).toBe(
			"This order is awaiting payment.",
		);
		expect(orderStamp({ ...base, state: "pending", returnedFromStripe: true })?.headline).toBe(
			"Payment submitted.",
		);
	});
});

describe("orderStamp — a pending order past its hold", () => {
	test("says the time to pay has run out — and claims NOTHING about stock or charges, since the order is still pending", () => {
		const stamp = orderStamp({ ...base, state: "pending", holdLapsed: true });
		expect(stamp).toEqual({
			headline: "The time to pay has run out.",
			// No poll runs here any more (QA U-13: polling only while a change is
			// expected), so the page must not promise to update itself.
			body: "If you already paid, check again in a minute — if the order has expired by then, your payment will be refunded.",
		});
		expect(stamp?.body).not.toMatch(/will update|refreshes/i);
		expect(stamp?.body).not.toMatch(/nothing was charged|back on sale/i);
	});

	test("a buyer just back from Stripe still sees 'Payment submitted' — their payment may yet settle", () => {
		expect(
			orderStamp({ ...base, state: "pending", holdLapsed: true, returnedFromStripe: true })
				?.headline,
		).toBe("Payment submitted.");
	});
});

describe("orderStamp — the rest", () => {
	test("no order ⇒ no stamp; paid and unknown states keep their copy", () => {
		expect(orderStamp({ ...base, state: null })).toBeNull();
		expect(orderStamp({ ...base, state: "paid" })?.headline).toBe("Order confirmed.");
		expect(orderStamp({ ...base, state: "shipped" })?.headline).toBe("Order status: shipped.");
	});
});

describe("orderStamp — the confirming copy says whether the page is still checking (QA U-13)", () => {
	const confirming = { ...base, state: "pending", returnedFromStripe: true } as const;

	test("while the poll runs, the page says it refreshes itself", () => {
		expect(orderStamp({ ...confirming, polling: true })?.body).toMatch(
			/This page refreshes automatically\.$/,
		);
	});

	test("once the poll has stopped, it says to check again — never that it refreshes", () => {
		const body = orderStamp({ ...confirming, polling: false })?.body ?? "";
		expect(body).not.toMatch(/refreshes automatically/);
		expect(body).toMatch(/check again/i);
	});
});
