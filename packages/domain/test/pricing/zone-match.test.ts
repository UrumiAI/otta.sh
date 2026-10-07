import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { ShippingZone } from "../../src/ports/shipping-rules-store.js";
import { resolveShippingZone } from "../../src/pricing/zone-match.js";

/** ADR-0021 Decisions 2–4: the zone comes from the address only; most
 *  specific (exact subdivision) wins; exact codes, no hierarchy. */
const zone = (id: string, regions: unknown): ShippingZone => ({ id, name: id, regions });

const US = zone("z-us", ["US"]);
const US_CA = zone("z-us-ca", ["US-CA"]);
const DE = zone("z-de", ["DE"]);

const physical = (country: string, region: string | null = null) => ({
	requiresShipping: true,
	destination: { country, region },
});

describe("resolveShippingZone", () => {
	test("a digital-only cart needs no zone — even when the address matches none", () => {
		expect(resolveShippingZone([US], { requiresShipping: false })).toEqual({
			status: "not_required",
		});
		expect(
			resolveShippingZone([US], {
				requiresShipping: false,
				destination: { country: "FR", region: null },
			}),
		).toEqual({ status: "not_required" });
	});

	test("no zones configured → no_zones (today's behaviour: no shipping, no tax)", () => {
		expect(resolveShippingZone([], physical("US", "CA"))).toEqual({ status: "no_zones" });
		expect(resolveShippingZone([], { requiresShipping: true })).toEqual({ status: "no_zones" });
	});

	test("zones but no destination → address_needed", () => {
		expect(resolveShippingZone([US], { requiresShipping: true })).toEqual({
			status: "address_needed",
		});
	});

	describe("zones {US, US-CA}", () => {
		const zones = [US, US_CA];

		test("a blank region → region_code_required (never a fallback to the country zone)", () => {
			expect(resolveShippingZone(zones, physical("US"))).toEqual({
				status: "region_code_required",
				country: "US",
			});
		});

		test("CA → the US-CA zone", () => {
			expect(resolveShippingZone(zones, physical("US", "CA"))).toEqual({
				status: "matched",
				zoneId: "z-us-ca",
				matchedRegion: "US-CA",
				ambiguousWith: [],
			});
		});

		test("TX → the US zone", () => {
			expect(resolveShippingZone(zones, physical("US", "TX"))).toEqual({
				status: "matched",
				zoneId: "z-us",
				matchedRegion: "US",
				ambiguousWith: [],
			});
		});

		test("the most specific zone wins whatever the list order (property)", () => {
			fc.assert(
				fc.property(
					fc.shuffledSubarray([US, US_CA, DE], { minLength: 3, maxLength: 3 }),
					(list) => {
						const result = resolveShippingZone(list, physical("US", "CA"));
						return result.status === "matched" && result.zoneId === "z-us-ca";
					},
				),
			);
		});
	});

	test("zones {DE}: a blank region or BY both match DE", () => {
		for (const region of [null, "BY"]) {
			expect(resolveShippingZone([DE], physical("DE", region))).toMatchObject({
				status: "matched",
				zoneId: "z-de",
				matchedRegion: "DE",
			});
		}
	});

	test("a US-CA-only zone does not match a US/TX address → unmatched", () => {
		expect(resolveShippingZone([US_CA], physical("US", "TX"))).toEqual({ status: "unmatched" });
	});

	test("exact codes only, no hierarchy: {FR-IDF} does not match FR/75C (Paris)", () => {
		expect(resolveShippingZone([zone("z-idf", ["FR-IDF"])], physical("FR", "75C"))).toEqual({
			status: "unmatched",
		});
	});

	test("a legacy free-text region never matches", () => {
		expect(
			resolveShippingZone(
				[zone("z-legacy", ["United States", "California"])],
				physical("US", "CA"),
			),
		).toEqual({ status: "unmatched" });
		expect(resolveShippingZone([zone("z-null", null)], physical("US", "CA"))).toEqual({
			status: "unmatched",
		});
	});

	test("region codes in zones are matched case-insensitively", () => {
		expect(resolveShippingZone([zone("z", ["us-ca"])], physical("US", "CA"))).toMatchObject({
			status: "matched",
			matchedRegion: "US-CA",
		});
	});

	test("a same-specificity tie → the lowest zone id, the others named in ambiguousWith", () => {
		const zones = [zone("z-b", ["US"]), zone("z-c", ["US", "CA"]), zone("z-a", ["us"])];
		expect(resolveShippingZone(zones, physical("US", "NY"))).toEqual({
			status: "matched",
			zoneId: "z-a",
			matchedRegion: "US",
			ambiguousWith: ["z-b", "z-c"],
		});
	});

	test("a subdivision zone for ANOTHER country does not demand a region", () => {
		expect(resolveShippingZone([US_CA, DE], physical("DE"))).toMatchObject({
			status: "matched",
			zoneId: "z-de",
		});
	});
});
