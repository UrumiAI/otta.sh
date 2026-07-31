/**
 * A3 (storefront-checkout plan §3) — boundary validation for the PUBLIC
 * checkout routes' input. These routes are reachable by anything that can POST
 * to `/_emdash/api/plugins/otta/...`, so the shape is hand-validated here
 * (route-input.ts style, no schema library in the plugin) and a malformed
 * request is rejected BEFORE any `ctx.http` egress — a garbage body must never
 * become an upstream round trip, let alone an order.
 */
import { describe, expect, test } from "vitest";
import {
	parseCheckoutPlaceInput,
	parseCheckoutSummaryInput,
	parseOrderRouteInput,
} from "../src/storefront/checkout-route-input.js";

const ADDRESS = {
	name: "A Buyer",
	line1: "1 Test St",
	city: "Testville",
	postalCode: "12345",
	country: "Testland",
};

describe("parseCheckoutSummaryInput", () => {
	test("accepts a non-empty cartId and canonicalizes the locale", () => {
		expect(parseCheckoutSummaryInput({ cartId: "cart-1", locale: "en-GB" })).toEqual({
			cartId: "cart-1",
			locale: "en-GB",
		});
	});

	test("a garbage locale degrades to the default rather than failing the render", () => {
		expect(parseCheckoutSummaryInput({ cartId: "cart-1", locale: "!!!" })?.locale).toBe("en");
		expect(parseCheckoutSummaryInput({ cartId: "cart-1" })?.locale).toBe("en");
	});

	test.each([[undefined], [""], [null], [42], [{}], [["cart-1"]]])(
		"rejects a cartId of %p",
		(cartId) => {
			expect(parseCheckoutSummaryInput({ cartId })).toBeNull();
		},
	);
});

describe("parseCheckoutPlaceInput", () => {
	test("accepts the minimum viable checkout — cartId, buyerRef, idempotencyKey", () => {
		expect(
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: "Buyer@Example.com",
				idempotencyKey: "checkout:cart-1",
			}),
		).toEqual({
			cartId: "cart-1",
			buyerRef: "Buyer@Example.com",
			idempotencyKey: "checkout:cart-1",
			locale: "en",
		});
	});

	test("the locale is display-only — canonicalized when given, defaulted when not", () => {
		// It formats the order total this route hands back (the pay button's
		// amount) and reaches no upstream call.
		const base = { cartId: "cart-1", buyerRef: "a@b.co", idempotencyKey: "k" };
		expect(parseCheckoutPlaceInput({ ...base, locale: "en-GB" })?.locale).toBe("en-GB");
		expect(parseCheckoutPlaceInput(base)?.locale).toBe("en");
	});

	test("a garbage locale degrades rather than failing the ORDER", () => {
		// The asymmetry that matters: a bad cartId is a reject, a bad locale is a
		// fallback. Nobody loses a purchase over a malformed language tag.
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
			locale: "!!!",
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.locale).toBe("en");
	});

	test("passes buyerRef through VERBATIM — never lowercased, never rewritten", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "A.B+tag@Example.co.UK",
			idempotencyKey: "k",
		});
		expect(parsed?.buyerRef).toBe("A.B+tag@Example.co.UK");
	});

	test.each([[undefined], [""], ["   "], [null], [42]])("rejects a buyerRef of %p", (buyerRef) => {
		expect(parseCheckoutPlaceInput({ cartId: "cart-1", buyerRef, idempotencyKey: "k" })).toBeNull();
	});

	test("rejects a buyerRef past the service's own 320-character bound", () => {
		expect(
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: `${"a".repeat(315)}@b.com`, // 321 chars
				idempotencyKey: "k",
			}),
		).toBeNull();
	});

	test.each([[undefined], [""], [null], [42]])("rejects a cartId of %p", (cartId) => {
		expect(parseCheckoutPlaceInput({ cartId, buyerRef: "a@b.co", idempotencyKey: "k" })).toBeNull();
	});

	test.each([[undefined], [""], [null], [42]])(
		"rejects an idempotencyKey of %p — the route never invents one",
		(idempotencyKey) => {
			expect(
				parseCheckoutPlaceInput({ cartId: "cart-1", buyerRef: "a@b.co", idempotencyKey }),
			).toBeNull();
		},
	);

	test("an ABSENT shippingAddress is fine (capture is optional this slice, ADR-0009)", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
		});
		expect(parsed).not.toBeNull();
		expect(parsed).not.toHaveProperty("shippingAddress");
	});

	test("a complete shippingAddress is kept, trimmed, with optionals omitted when blank", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
			shippingAddress: { ...ADDRESS, name: "  A Buyer  ", line2: "", region: "TS" },
		});
		expect(parsed?.shippingAddress).toEqual({ ...ADDRESS, region: "TS" });
	});

	test.each([["name"], ["line1"], ["city"], ["postalCode"], ["country"]])(
		"rejects a shippingAddress whose required field %s is blank",
		(field) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress: { ...ADDRESS, [field]: "   " },
				}),
			).toBeNull();
		},
	);

	test.each([[42], [null], [{}], [["x"]], [true]])(
		"rejects a NON-STRING shippingAddress field (%p)",
		(bogus) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress: { ...ADDRESS, city: bogus },
				}),
			).toBeNull();
		},
	);

	test.each([
		["name", 201],
		["line1", 201],
		["city", 121],
		["postalCode", 33],
		["country", 101],
	])("rejects a shippingAddress whose %s exceeds its bound", (field, length) => {
		expect(
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: "a@b.co",
				idempotencyKey: "k",
				shippingAddress: { ...ADDRESS, [field]: "x".repeat(length) },
			}),
		).toBeNull();
	});

	test.each([[42], ["not an object"], [["x"]], [null]])(
		"rejects a shippingAddress that is not an object (%p)",
		(shippingAddress) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress,
				}),
			).toBeNull();
		},
	);
});

describe("parseOrderRouteInput", () => {
	test("accepts a non-empty orderId and canonicalizes the locale", () => {
		expect(parseOrderRouteInput({ orderId: "order-1", locale: "en-GB" })).toEqual({
			orderId: "order-1",
			locale: "en-GB",
		});
	});

	test.each([[undefined], [""], [null], [42]])("rejects an orderId of %p", (orderId) => {
		expect(parseOrderRouteInput({ orderId })).toBeNull();
	});
});
