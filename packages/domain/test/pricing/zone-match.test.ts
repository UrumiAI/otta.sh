import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { ShippingZone } from "../../src/ports/shipping-rules-store.js";
import { resolveShippingZone } from "../../src/pricing/zone-match.js";

/** ADR-0021 Decisions 2–4: the zone comes from the address only; most
 *  specific wins — the subdivision, then each subdivision containing it (CLDR
 *  containment, amended 2026-10-09), then the country. */
const zone = (id: string, regions: unknown): ShippingZone => ({ id, name: id, regions });

const US = zone("z-us", ["US"]);
const US_CA = zone("z-us-ca", ["US-CA"]);
const DE = zone("z-de", ["DE"]);

const matched = (zoneId: string, matchedRegion: string) => ({
	status: "matched",
	zoneId,
	matchedRegion,
	ambiguousWith: [],
});

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

	describe("a subdivision inside another (CLDR containment)", () => {
		const ES = zone("z-es", ["ES"]);
		const ES_CN = zone("z-es-cn", ["ES-CN"]);

		test("Canary Islands: Santa Cruz de Tenerife (TF) takes the ES-CN zone, not ES", () => {
			expect(resolveShippingZone([ES, ES_CN], physical("ES", "TF"))).toEqual(
				matched("z-es-cn", "ES-CN"),
			);
			expect(resolveShippingZone([ES_CN, ES], physical("ES", "GC"))).toEqual(
				matched("z-es-cn", "ES-CN"),
			);
		});

		test("the parent zone alone still serves its child (no ES zone: no refusal)", () => {
			expect(resolveShippingZone([ES_CN], physical("ES", "TF"))).toEqual(
				matched("z-es-cn", "ES-CN"),
			);
		});

		test("a province outside the parent falls to the country, or nowhere", () => {
			expect(resolveShippingZone([ES, ES_CN], physical("ES", "M"))).toEqual(matched("z-es", "ES"));
			expect(resolveShippingZone([ES_CN], physical("ES", "M"))).toEqual({ status: "unmatched" });
		});

		test("Northern Ireland: Belfast (BFS) takes GB-NIR; England's councils take GB", () => {
			const zones = [zone("z-gb", ["GB"]), zone("z-nir", ["GB-NIR"])];
			expect(resolveShippingZone(zones, physical("GB", "BFS"))).toEqual(matched("z-nir", "GB-NIR"));
			expect(resolveShippingZone(zones, physical("GB", "NIR"))).toEqual(matched("z-nir", "GB-NIR"));
			expect(resolveShippingZone(zones, physical("GB", "KEC"))).toEqual(matched("z-gb", "GB"));
		});

		test("a zone on the child still wins over its parent's, whatever the list order", () => {
			const TF = zone("z-tf", ["ES-TF"]);
			for (const zones of [
				[ES, ES_CN, TF],
				[TF, ES_CN, ES],
			]) {
				expect(resolveShippingZone(zones, physical("ES", "TF"))).toEqual(matched("z-tf", "ES-TF"));
				expect(resolveShippingZone(zones, physical("ES", "GC"))).toEqual(
					matched("z-es-cn", "ES-CN"),
				);
			}
		});

		test("Paris (FR-75C) is in Île-de-France: an FR-IDF zone covers it", () => {
			expect(resolveShippingZone([zone("z-idf", ["FR-IDF"])], physical("FR", "75C"))).toEqual(
				matched("z-idf", "FR-IDF"),
			);
		});

		test("a pick CONTAINING a zoned subdivision is asked to be more specific — never matched to the country", () => {
			const required = (country: string) => ({ status: "region_code_required", country });
			// [ES 21%, ES-TF 0%]: "Canary Islands" could be Tenerife or Las Palmas.
			expect(resolveShippingZone([ES, zone("z-tf", ["ES-TF"])], physical("ES", "CN"))).toEqual(
				required("ES"),
			);
			// [GB, GB-BFS]: "Northern Ireland" could be Belfast.
			expect(
				resolveShippingZone(
					[zone("z-gb", ["GB"]), zone("z-bfs", ["GB-BFS"])],
					physical("GB", "NIR"),
				),
			).toEqual(required("GB"));
			// No country zone at all: asked, not refused.
			expect(resolveShippingZone([zone("z-tf", ["ES-TF"])], physical("ES", "CN"))).toEqual(
				required("ES"),
			);
		});

		test("…but a zone on the pick itself, or on a subdivision containing it, still matches", () => {
			const TF = zone("z-tf", ["ES-TF"]);
			expect(resolveShippingZone([ES, ES_CN, TF], physical("ES", "CN"))).toEqual(
				matched("z-es-cn", "ES-CN"),
			);
			expect(resolveShippingZone([ES, TF], physical("ES", "TF"))).toEqual(matched("z-tf", "ES-TF"));
			// A sibling's zone does not make Las Palmas ask again: GC falls to ES.
			expect(resolveShippingZone([ES, TF], physical("ES", "GC"))).toEqual(matched("z-es", "ES"));
		});

		test("a blank region still asks for one when only a parent is zoned", () => {
			expect(resolveShippingZone([ES, ES_CN], physical("ES"))).toEqual({
				status: "region_code_required",
				country: "ES",
			});
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
