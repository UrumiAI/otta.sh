import { describe, expect, test } from "vitest";
import {
	flagAmount,
	PROVIDER_REFUNDED_FLAG_PREFIX,
	providerRefundedFlag,
} from "../../src/orders/provider-refunded-flag.js";

// The provider-refund flag states amounts in the currency's REAL minor units
// (review round 2): JPY has none, BHD three — never a blanket two decimals.
describe("flagAmount", () => {
	test.each([
		[350, "USD", "3.50 USD"],
		[5, "USD", "0.05 USD"],
		[1500, "JPY", "1500 JPY"],
		[1234, "BHD", "1.234 BHD"],
	])("%i %s → %s", (minor, currency, text) => {
		expect(flagAmount(minor, currency)).toBe(text);
	});

	test("a full JPY refund flags in yen, not hundredths", () => {
		const flag = providerRefundedFlag({ refunded: 1500, captured: 1500 }, "JPY");
		expect(flag).toMatch(new RegExp(`^${PROVIDER_REFUNDED_FLAG_PREFIX}`));
		expect(flag).toContain("1500 JPY of 1500 JPY");
	});
});
