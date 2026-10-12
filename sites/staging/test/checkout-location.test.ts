/**
 * Issue #426: which "where" block the review shows — the delivery block for a
 * cart that ships in a zoned store (ADR-0021), the buyer's-location block for a
 * cart that ships nothing in a store taxing it where the buyer is, or neither —
 * and what the place form's echo of that location becomes.
 */
import { describe, expect, test } from "vitest";
import {
	billingLocationFromForm,
	buyerLocationErrorToken,
	locationBlock,
} from "../src/lib/checkout-location.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";

const summary = (
	requiresShipping: boolean,
	status: "not_required" | "no_zones" | "address_needed" | "matched",
	taxByBuyerLocation = false,
) => ({ requiresShipping, shipping: { status }, taxByBuyerLocation });

describe("locationBlock", () => {
	test("a cart that ships, in a zoned store ⇒ delivery (as before)", () => {
		expect(locationBlock(summary(true, "address_needed"), false)).toBe("delivery");
		expect(locationBlock(summary(true, "matched", true), false)).toBe("delivery");
	});

	test("a cart that ships, no zones ⇒ none (as before)", () => {
		expect(locationBlock(summary(true, "no_zones"), false)).toBeNull();
	});

	test("a cart that ships nothing ⇒ none, unless the store taxes it where the buyer is", () => {
		expect(locationBlock(summary(false, "not_required"), false)).toBeNull();
		expect(locationBlock(summary(false, "not_required", true), false)).toBe("buyer");
	});

	test("a locked review shows neither", () => {
		expect(locationBlock(summary(true, "matched"), true)).toBeNull();
		expect(locationBlock(summary(false, "not_required", true), true)).toBeNull();
	});
});

describe("buyerLocationErrorToken (review round 1)", () => {
	test("a refused buyer location is not called a delivery address", () => {
		const token = buyerLocationErrorToken("INVALID_SHIPPING_ADDRESS");
		expect(token).not.toBe("INVALID_SHIPPING_ADDRESS");
		expect(cartErrorMessage(token)).not.toMatch(/deliver/i);
		expect(cartErrorMessage(token)).toMatch(/country/i);
		expect(cartErrorMessage(buyerLocationErrorToken("SHIPPING_ZONE_NOT_MATCHED"))).not.toMatch(
			/ship/i,
		);
	});

	test("the region refusal keeps its own (already neutral) copy", () => {
		expect(buyerLocationErrorToken("SHIPPING_REGION_CODE_REQUIRED")).toBe(
			"SHIPPING_REGION_CODE_REQUIRED",
		);
	});
});

describe("billingLocationFromForm", () => {
	test("the buyer-location page's priced echo ⇒ the billing location, codes uppercased", () => {
		expect(billingLocationFromForm({ taxLocation: "buyer", country: "de" })).toEqual({
			country: "DE",
		});
		expect(billingLocationFromForm({ taxLocation: "buyer", country: "US", region: "ca" })).toEqual({
			country: "US",
			region: "CA",
		});
	});

	test("no marker (a delivery page), no country, or a crafted value ⇒ none", () => {
		expect(billingLocationFromForm({ country: "DE" })).toBeUndefined();
		expect(billingLocationFromForm({ taxLocation: "buyer" })).toBeUndefined();
		expect(billingLocationFromForm({ taxLocation: "buyer", country: "Germany" })).toBeUndefined();
		expect(
			billingLocationFromForm({ taxLocation: "buyer", country: "US", region: "Cali fornia" }),
		).toEqual({ country: "US" });
	});
});
