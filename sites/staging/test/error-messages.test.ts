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

	test("OUT_OF_STOCK, HOLD_EXPIRED, CART_NOT_FOUND get DISTINCT, specific copy (not all collapsed to the generic fallback)", () => {
		const outOfStock = cartErrorMessage("OUT_OF_STOCK");
		const holdExpired = cartErrorMessage("HOLD_EXPIRED");
		const cartNotFound = cartErrorMessage("CART_NOT_FOUND");
		expect(new Set([outOfStock, holdExpired, cartNotFound]).size).toBe(3);
	});
});
