/**
 * Friendly-copy mapping for the `?error=<TOKEN>` query param shoppers can
 * land on (item 2 — raw error tokens shown to shoppers). The raw token stays
 * in the URL/console for debugging; this is the ONE function that decides
 * what a shopper actually reads, and it must never echo a machine token
 * verbatim — including for a token this file doesn't yet know about.
 */
import { describe, expect, test } from "vitest";
import { cartErrorMessage } from "../src/lib/error-messages.js";

const SELECTION_TOKENS = [
	"COUPON_NOT_FOUND",
	"COUPON_NOT_ACTIVE",
	"COUPON_MIN_SUBTOTAL",
	"COUPON_EXHAUSTED",
	"COUPON_MAX_PER_CUSTOMER",
	"COUPON_CURRENCY_MISMATCH",
	"SHIPPING_METHOD_NOT_FOUND",
	"SHIPPING_RATE_NOT_FOUND",
	// #305 part 2 (ADR-0021) — the zone derived from the address.
	"SHIPPING_ZONE_NOT_MATCHED",
	"SHIPPING_REGION_CODE_REQUIRED",
	"SHIPPING_METHOD_NOT_IN_ZONE",
	"SHIPPING_METHOD_REQUIRED",
	"SHIPPING_METHOD_NOT_APPLICABLE",
	"MISSING_SHIPPING_ADDRESS",
];

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
	// Checkout (storefront-checkout plan §3 C7).
	"CART_EMPTY",
	"RESERVATION_LOST",
	"PRODUCT_NOT_PRICED",
	"CURRENCY_MISMATCH",
	"PAYMENT_INTENT_FAILED",
	"IDEMPOTENCY_KEY_REUSED",
	"INVALID_SHIPPING_ADDRESS",
	"INVALID_EMAIL",
	"ORDER_NOT_FOUND",
	"STRIPE_NOT_CONFIGURED",
	// #305 part 1 — the buyer's selection, at the summary and at place.
	...SELECTION_TOKENS,
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

	test.each(SELECTION_TOKENS)("%s has its OWN copy, not the generic fallback", (token) => {
		expect(cartErrorMessage(token)).not.toBe(cartErrorMessage("SOME_UNMAPPED_TOKEN"));
	});

	test("the coupon and shipping copy is distinct per reason — a buyer can tell them apart", () => {
		const coupon = SELECTION_TOKENS.filter((t) => t.startsWith("COUPON_")).map(cartErrorMessage);
		expect(new Set(coupon).size).toBe(coupon.length);
	});

	test("COUPON_NOT_FOUND tells the buyer to check the code, and that case matters", () => {
		const message = cartErrorMessage("COUPON_NOT_FOUND");
		expect(message).toMatch(/check/i);
		expect(message).toMatch(/case-sensitive/i);
	});

	test("SHIPPING_ZONE_NOT_MATCHED says plainly that the store does not ship there", () => {
		expect(cartErrorMessage("SHIPPING_ZONE_NOT_MATCHED")).toBe("We don't ship to this address.");
	});

	test("SHIPPING_REGION_CODE_REQUIRED asks for a CODE, and says blank is fine where a country uses none", () => {
		const message = cartErrorMessage("SHIPPING_REGION_CODE_REQUIRED");
		expect(message).toMatch(/code/i);
		expect(message).toMatch(/e\.g\. CA/);
		expect(message).toMatch(/leave it blank/i);
	});

	test("SHIPPING_METHOD_REQUIRED is about the ADDRESS having no delivery options — not a nag to choose", () => {
		expect(cartErrorMessage("SHIPPING_METHOD_REQUIRED")).toMatch(/no delivery options/i);
	});

	test("the shipping copy is distinct per reason too", () => {
		const shipping = SELECTION_TOKENS.filter((t) => !t.startsWith("COUPON_")).map(cartErrorMessage);
		expect(new Set(shipping).size).toBe(shipping.length);
	});
});
