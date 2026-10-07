import { describe, expect, test } from "vitest";
import { normalizeOrderAddress, type OrderAddressInput } from "../../src/orders/order-address.js";

/** ADR-0021 Decisions 3 and 6: every new order's address carries an ISO
 *  alpha-2 country, and a non-blank region is a real subdivision of it, stored
 *  as the canonical bare code. */
const base: OrderAddressInput = {
	name: "Ada",
	line1: "1 Main St",
	city: "Springfield",
	postalCode: "12345",
	country: "US",
};

describe("normalizeOrderAddress — ISO codes", () => {
	test("the country is uppercased and trimmed", () => {
		const result = normalizeOrderAddress({ ...base, country: " us " });
		expect(result).toMatchObject({ ok: true, value: { country: "US" } });
	});

	test.each(["us-ca", "US-CA", "ca", " CA "])(
		"region %j is stored as the bare code CA",
		(region) => {
			expect(normalizeOrderAddress({ ...base, region })).toMatchObject({
				ok: true,
				value: { region: "CA" },
			});
		},
	);

	test("a blank region is stored as null", () => {
		expect(normalizeOrderAddress({ ...base, region: "  " })).toMatchObject({
			ok: true,
			value: { region: null },
		});
	});

	test.each(["United States", "ZZ", "UK", "USA", "EU"])("country %j → INVALID", (country) => {
		expect(normalizeOrderAddress({ ...base, country })).toEqual({ ok: false, reason: "INVALID" });
	});

	test.each([
		["DE", "Bavaria"],
		["US", "XX"],
		["US", "MX-CA"],
		["US", "California"],
	])("(%s, %j) → REGION_NOT_A_CODE", (country, region) => {
		expect(normalizeOrderAddress({ ...base, country, region })).toEqual({
			ok: false,
			reason: "REGION_NOT_A_CODE",
		});
	});

	test("a missing required field is INVALID, before the region is looked at", () => {
		expect(normalizeOrderAddress({ ...base, city: " ", region: "Bavaria" })).toEqual({
			ok: false,
			reason: "INVALID",
		});
	});

	test("XK (D11) is a valid country with no region", () => {
		expect(normalizeOrderAddress({ ...base, country: "xk" })).toMatchObject({
			ok: true,
			value: { country: "XK", region: null },
		});
	});
});
