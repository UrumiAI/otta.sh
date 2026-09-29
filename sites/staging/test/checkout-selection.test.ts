/**
 * #305 part 1 — how the buyer's coupon rides the review page.
 *
 * The coupon travels as `GET /checkout?coupon=CODE` (decision D2): the summary
 * it drives is read-only (a quote redeems nothing), so a GET is safe, reload-safe
 * and needs no cookie. These are the pure rules the page and the place endpoint
 * share; `.astro` has no render harness (issue #40), so they live here.
 */
import { describe, expect, test } from "vitest";
import { checkoutPath, placeFailurePath, readCouponParam } from "../src/lib/checkout-selection.js";

const at = (search: string) => new URL(`http://localhost:4321/checkout${search}`);

describe("readCouponParam", () => {
	test("trims the code and KEEPS its case — coupon lookup is case-sensitive", () => {
		expect(readCouponParam(at("?coupon=%20Ck-Save5%20"))).toEqual({ couponCode: "Ck-Save5" });
	});

	test.each([[""], ["?coupon="], ["?coupon=%20%20"]])(
		"a blank or absent coupon (%p) is no coupon",
		(search) => {
			expect(readCouponParam(at(search))).toEqual({});
		},
	);

	test("a code over 200 characters is rejected HERE as COUPON_NOT_FOUND, never sent to the plugin", () => {
		const code = "X".repeat(201);
		expect(readCouponParam(at(`?coupon=${code}`))).toEqual({
			rejected: { code, reason: "COUPON_NOT_FOUND" },
		});
	});

	test("exactly 200 characters is still a code", () => {
		const code = "X".repeat(200);
		expect(readCouponParam(at(`?coupon=${code}`))).toEqual({ couponCode: code });
	});
});

describe("checkoutPath", () => {
	test("is bare /checkout with nothing to carry", () => {
		expect(checkoutPath({})).toBe("/checkout");
	});

	test("encodes the coupon and the error token", () => {
		expect(checkoutPath({ couponCode: "A&B=C D", error: "INVALID_EMAIL" })).toBe(
			"/checkout?coupon=A%26B%3DC+D&error=INVALID_EMAIL",
		);
	});
});

describe("placeFailurePath", () => {
	test.each([
		["COUPON_NOT_FOUND"],
		["COUPON_NOT_ACTIVE"],
		["COUPON_MIN_SUBTOTAL"],
		["COUPON_EXHAUSTED"],
		["COUPON_MAX_PER_CUSTOMER"],
		["COUPON_CURRENCY_MISMATCH"],
	])(
		"a %s place failure DROPS the coupon — the page re-renders without the discount, with one notice",
		(token) => {
			expect(placeFailurePath(token, "CK-SAVE5")).toBe(`/checkout?error=${token}`);
		},
	);

	test.each([
		["PAYMENT_INTENT_FAILED"],
		["INVALID_EMAIL"],
		["RESERVATION_LOST"],
		["SERVICE_UNAVAILABLE"],
		["STRIPE_NOT_CONFIGURED"],
	])("a %s failure KEEPS the coupon (it is not personal data)", (token) => {
		expect(placeFailurePath(token, "CK-SAVE5")).toBe(`/checkout?coupon=CK-SAVE5&error=${token}`);
	});

	test("no coupon, nothing to keep", () => {
		expect(placeFailurePath("INVALID_EMAIL", undefined)).toBe("/checkout?error=INVALID_EMAIL");
	});
});
