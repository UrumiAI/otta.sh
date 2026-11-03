/**
 * ADR-0044: what the buyer is told about a cash-on-delivery order. It is placed,
 * not awaiting an online payment: no pay page, no "time ran out", no hold timer,
 * and the step tracker is past Payment. A card order is unchanged.
 */
import { describe, expect, test } from "vitest";
import { accountOrderStatus } from "../src/lib/account.js";
import { orderStamp } from "../src/lib/order-stamp.js";
import { orderProgress } from "../src/lib/order-view.js";
import { isOrderPayable } from "../src/lib/pay-guard.js";
import { paymentMethodName } from "../src/lib/stripe-config.js";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const NEVER = "9999-12-31T23:59:59.999Z";
const SOON = "2026-11-03T12:10:00.000Z";

describe("a pending cash-on-delivery order", () => {
	test("is never payable on the pay page, whatever its deadline", () => {
		expect(
			isOrderPayable({ state: "pending", holdExpiresAt: NEVER, paymentMethod: "cod" }, NOW),
		).toBe(false);
		// A card order inside its hold still is.
		expect(
			isOrderPayable({ state: "pending", holdExpiresAt: SOON, paymentMethod: "stripe" }, NOW),
		).toBe(true);
		expect(isOrderPayable({ state: "pending", holdExpiresAt: SOON }, NOW)).toBe(true);
	});

	test("reads as placed, pay on delivery — never 'awaiting payment' or 'time ran out'", () => {
		const stamp = orderStamp({
			state: "pending",
			latePayment: "none",
			returnedFromStripe: false,
			holdLapsed: true,
			polling: false,
			paymentMethod: "cod",
		});
		expect(stamp).toEqual({
			headline: "Order placed.",
			body: "You'll pay in cash when your order is delivered. We've emailed you the details.",
		});
		expect(
			accountOrderStatus({ state: "pending", holdExpiresAt: NEVER, paymentMethod: "cod" }, NOW),
		).toBe("Placed — pay on delivery");
	});

	test("a card order's pending copy is unchanged", () => {
		expect(
			orderStamp({
				state: "pending",
				latePayment: "none",
				returnedFromStripe: false,
				holdLapsed: false,
				polling: false,
				paymentMethod: "stripe",
			}),
		).toEqual({ headline: "This order is awaiting payment.", body: null });
	});

	test("the step tracker is at Order, not Payment", () => {
		expect(orderProgress("pending", "cod")).toEqual({ current: "order", halted: false });
		expect(orderProgress("pending", "stripe")).toEqual({ current: "payment", halted: false });
		expect(orderProgress("pending")).toEqual({ current: "payment", halted: false });
	});

	test("the method is named for a buyer, and an unknown one is not guessed", () => {
		expect(paymentMethodName("cod")).toBe("Cash on delivery");
		expect(paymentMethodName("stripe")).toBe("Card");
		expect(paymentMethodName("x402")).toBeNull();
		expect(paymentMethodName(null)).toBeNull();
	});
});
