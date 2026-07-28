/**
 * Friendly-copy mapping for the `?error=<TOKEN>` query param shoppers can
 * land on (item 2 — raw error tokens shown to shoppers). The raw token stays
 * in the URL/console for debugging; this is the ONE function that decides
 * what a shopper actually reads, and it must never echo a machine token
 * verbatim — including for a token this file doesn't yet know about.
 */
import { describe, expect, test } from "vitest";
import { cartErrorMessage } from "../src/lib/error-messages.js";

const KNOWN_TOKENS = [
	"OUT_OF_STOCK",
	"CART_NOT_FOUND",
	"LINE_NOT_FOUND",
	"CART_CHECKED_OUT",
	"LINE_CHECKED_OUT",
	"HOLD_EXPIRED",
	"SKU_MISMATCH",
	"INVALID_INPUT",
	"INVALID_CART_ID",
	"INVALID_CURRENCY",
	"RENDER_FAILED",
	"SERVICE_UNAVAILABLE",
	"PRODUCT_NOT_FOUND",
	"PRODUCT_UNAVAILABLE",
	// Checkout (storefront-checkout plan §3 C7). Coupon/shipping-method tokens
	// are deliberately absent: no such input is offered, so they are unreachable.
	"CART_EMPTY",
	"RESERVATION_LOST",
	"PRODUCT_NOT_PRICED",
	"CURRENCY_MISMATCH",
	"PAYMENT_INTENT_FAILED",
	"INVALID_SHIPPING_ADDRESS",
	"INVALID_EMAIL",
	"ORDER_NOT_FOUND",
	"STRIPE_NOT_CONFIGURED",
];

describe("cartErrorMessage", () => {
	test.each(KNOWN_TOKENS)(
		"%s maps to a non-empty, human string that is not the raw token",
		(token) => {
			const message = cartErrorMessage(token);
			expect(typeof message).toBe("string");
			expect(message.length).toBeGreaterThan(0);
			expect(message).not.toBe(token);
		},
	);

	test("an unrecognized/future token still returns a safe generic fallback — never undefined, never echoed", () => {
		const message = cartErrorMessage("SOME_FUTURE_TOKEN_NOBODY_MAPPED_YET");
		expect(typeof message).toBe("string");
		expect(message.length).toBeGreaterThan(0);
		expect(message).not.toBe("SOME_FUTURE_TOKEN_NOBODY_MAPPED_YET");
	});

	test("an empty-string token returns the generic fallback, not an empty string", () => {
		expect(cartErrorMessage("")).not.toBe("");
	});

	test("PAYMENT_INTENT_FAILED says NO CHARGE WAS MADE — the one fact a buyer needs when a gateway call dies mid-checkout", () => {
		// The pending order row is kept deliberately (expire-orders sweeps it at
		// TTL), so the copy must NOT tell the buyer to make a new cart either.
		const message = cartErrorMessage("PAYMENT_INTENT_FAILED");
		expect(message).toMatch(/no charge was made/i);
		expect(message).not.toMatch(/new cart/i);
	});

	test("PRODUCT_NOT_PRICED and CURRENCY_MISMATCH both say the item is no longer available for purchase (§1.7 copy, quoted not paraphrased)", () => {
		const expected = "One of the items in your cart is no longer available for purchase.";
		expect(cartErrorMessage("PRODUCT_NOT_PRICED")).toBe(expected);
		expect(cartErrorMessage("CURRENCY_MISMATCH")).toBe(expected);
	});

	test("RESERVATION_LOST explains the expired hold and points at the cart, without blaming the buyer", () => {
		expect(cartErrorMessage("RESERVATION_LOST")).toMatch(/expired/i);
	});

	test("INVALID_EMAIL is specific enough to act on", () => {
		const message = cartErrorMessage("INVALID_EMAIL");
		expect(message).toMatch(/email/i);
		expect(message).not.toBe(cartErrorMessage("RENDER_FAILED"));
	});

	test("STRIPE_NOT_CONFIGURED is honest about the STORE, not the buyer", () => {
		const message = cartErrorMessage("STRIPE_NOT_CONFIGURED");
		expect(message).toMatch(/store/i);
		expect(message).not.toMatch(/your (card|payment)/i);
	});

	test("OUT_OF_STOCK, HOLD_EXPIRED, CART_NOT_FOUND get DISTINCT, specific copy (not all collapsed to the generic fallback)", () => {
		const outOfStock = cartErrorMessage("OUT_OF_STOCK");
		const holdExpired = cartErrorMessage("HOLD_EXPIRED");
		const cartNotFound = cartErrorMessage("CART_NOT_FOUND");
		expect(new Set([outOfStock, holdExpired, cartNotFound]).size).toBe(3);
	});
});
