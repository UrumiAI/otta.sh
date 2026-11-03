/**
 * ADR-0044: what the buyer is told about a cash-on-delivery order. It is placed
 * in its own states — `awaiting_payment`, then `shipped_awaiting_payment` if it
 * ships before the cash is collected — never `pending`: no pay page, no "time
 * ran out", no hold timer, and the step tracker is at Order. Every branch reads
 * the order's `settlement`, never the method's name. A card order is unchanged.
 */
import { describe, expect, test } from "vitest";
import { accountOrderStatus } from "../src/lib/account.js";
import { isSpentCart } from "../src/lib/cart-rotation.js";
import { orderStamp, type OrderStampInput } from "../src/lib/order-stamp.js";
import { orderProgress } from "../src/lib/order-view.js";
import { isOrderPayable } from "../src/lib/pay-guard.js";
import { paymentMethodName } from "../src/lib/stripe-config.js";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const SOON = "2026-11-03T12:10:00.000Z";
const PAST = "2026-11-03T11:00:00.000Z";

function stamp(
	state: string,
	settlement: OrderStampInput["settlement"],
): ReturnType<typeof orderStamp> {
	return orderStamp({
		state,
		latePayment: "none",
		returnedFromStripe: false,
		holdLapsed: false,
		polling: false,
		settlement,
	});
}

describe("an offline (cash-on-delivery) order", () => {
	test("is never payable on the pay page — in its own states, or pending for the instant before its flip", () => {
		for (const state of ["awaiting_payment", "shipped_awaiting_payment"]) {
			expect(
				isOrderPayable({ state, holdExpiresAt: SOON, settlement: "offline" }, NOW),
				state,
			).toBe(false);
		}
		expect(
			isOrderPayable({ state: "pending", holdExpiresAt: SOON, settlement: "offline" }, NOW),
		).toBe(false);
		// A card order inside its hold still is.
		expect(
			isOrderPayable({ state: "pending", holdExpiresAt: SOON, settlement: "gateway" }, NOW),
		).toBe(true);
		expect(isOrderPayable({ state: "pending", holdExpiresAt: SOON }, NOW)).toBe(true);
	});

	test("placed: 'Order placed.' and pay in cash on delivery — no 'we've emailed you'", () => {
		expect(stamp("awaiting_payment", "offline")).toEqual({
			headline: "Order placed.",
			body: "You'll pay in cash when your order is delivered.",
		});
		expect(
			accountOrderStatus(
				{ state: "awaiting_payment", holdExpiresAt: PAST, settlement: "offline" },
				NOW,
			),
		).toBe("Placed — pay on delivery");
	});

	test("shipped before payment: on its way, cash on delivery", () => {
		expect(stamp("shipped_awaiting_payment", "offline")).toEqual({
			headline: "Your order is on its way.",
			body: "You'll pay in cash on delivery.",
		});
		expect(
			accountOrderStatus(
				{ state: "shipped_awaiting_payment", holdExpiresAt: PAST, settlement: "offline" },
				NOW,
			),
		).toBe("Shipped — pay on delivery");
	});

	test("Mark paid: paid and delivered say the CASH was received", () => {
		expect(stamp("paid", "offline")).toEqual({
			headline: "Payment received.",
			body: "Thank you — we've received your cash payment.",
		});
		expect(stamp("delivered", "offline")).toEqual({
			headline: "Order delivered.",
			body: "Payment received — thank you.",
		});
	});

	test("no stamp, in any state, promises an email", () => {
		for (const state of ["awaiting_payment", "shipped_awaiting_payment", "paid", "delivered"]) {
			const copy = stamp(state, "offline");
			expect(`${copy?.headline} ${copy?.body}`, state).not.toMatch(/email/i);
		}
	});

	test("the unpaid states read the same on an older wire with no settlement", () => {
		expect(stamp("awaiting_payment", null)?.headline).toBe("Order placed.");
		expect(stamp("shipped_awaiting_payment", undefined)?.headline).toBe(
			"Your order is on its way.",
		);
	});

	test("a card order's copy is unchanged", () => {
		expect(stamp("pending", "gateway")).toEqual({
			headline: "This order is awaiting payment.",
			body: null,
		});
		expect(stamp("paid", "gateway")).toEqual({
			headline: "Order confirmed.",
			body: "Thank you — we've received your payment.",
		});
	});

	test("the step tracker sits at Order in both unpaid states", () => {
		expect(orderProgress("awaiting_payment")).toEqual({ current: "order", halted: false });
		expect(orderProgress("shipped_awaiting_payment")).toEqual({
			current: "order",
			halted: false,
		});
		expect(orderProgress("pending")).toEqual({ current: "payment", halted: false });
	});

	test("its cart is spent once placed, so the confirmation page forgets the cookie (review finding 1)", () => {
		const order = { id: "ord-1", state: "awaiting_payment" };
		expect(isSpentCart({ orderId: "ord-1" }, order)).toBe(true);
		// Another cart, or a cart that became no order, is kept.
		expect(isSpentCart({ orderId: "ord-2" }, order)).toBe(false);
		expect(isSpentCart({ orderId: null }, order)).toBe(false);
	});

	test("the method is named for a buyer, and an unknown one is not guessed", () => {
		expect(paymentMethodName("cod")).toBe("Cash on delivery");
		expect(paymentMethodName("stripe")).toBe("Card");
		expect(paymentMethodName("x402")).toBeNull();
		expect(paymentMethodName(null)).toBeNull();
	});
});
