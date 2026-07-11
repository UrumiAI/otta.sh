import { cents, resolveShippingRate, type ShippingMethodSnapshot } from "@urumi/domain";
import { describe, expect, test } from "vitest";

const flat: ShippingMethodSnapshot = {
	zoneId: "z1",
	methodId: "m-flat",
	type: "flat_rate",
	amountCents: cents(599),
	minSubtotalCents: null,
};

describe("resolveShippingRate", () => {
	test("flat_rate returns the configured rate for the zone/method, independent of subtotal", () => {
		expect(resolveShippingRate(flat, cents(0))).toBe(599);
		expect(resolveShippingRate(flat, cents(100_000_00))).toBe(599);
	});

	test("free_shipping returns 0 once the discounted subtotal meets minSubtotalCents, else the fallback", () => {
		const free: ShippingMethodSnapshot = {
			zoneId: "z1",
			methodId: "m-free",
			type: "free_shipping",
			amountCents: cents(799), // below-threshold fallback
			minSubtotalCents: cents(50_00),
		};
		expect(resolveShippingRate(free, cents(50_00))).toBe(0); // meets threshold
		expect(resolveShippingRate(free, cents(60_00))).toBe(0); // above threshold
		expect(resolveShippingRate(free, cents(49_99))).toBe(799); // below ⇒ fallback
	});

	test("free_shipping with no threshold is always free", () => {
		const free: ShippingMethodSnapshot = {
			zoneId: "z1",
			methodId: "m-free",
			type: "free_shipping",
			amountCents: cents(0),
			minSubtotalCents: null,
		};
		expect(resolveShippingRate(free, cents(0))).toBe(0);
	});
});
