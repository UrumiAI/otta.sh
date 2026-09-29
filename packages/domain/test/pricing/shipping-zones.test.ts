import { parseShippingRegions, resolveShippingZone, type ShippingZone } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

function zone(id: string, regions: unknown): ShippingZone {
	return { id, name: id.toUpperCase(), regions };
}

describe("parseShippingRegions — the format the admin Shipping page writes", () => {
	test("a string[] of ISO country / ISO 3166-2 subdivision codes parses, case- and space-insensitively", () => {
		expect(parseShippingRegions(["US", " ca ", "us-ny", "GB-ENG"])).toEqual({
			ok: true,
			regions: [
				{ country: "US", subdivision: null },
				{ country: "CA", subdivision: null },
				{ country: "US", subdivision: "NY" },
				{ country: "GB", subdivision: "ENG" },
			],
		});
	});

	test("null / absent / an empty list is a zone with no regions (it matches no address)", () => {
		expect(parseShippingRegions(null)).toEqual({ ok: true, regions: [] });
		expect(parseShippingRegions(undefined)).toEqual({ ok: true, regions: [] });
		expect(parseShippingRegions([])).toEqual({ ok: true, regions: [] });
	});

	test("malformed tokens are named, never guessed at", () => {
		expect(parseShippingRegions(["US", "United States", "U", "US-", "US-TOOLONG", "*"])).toEqual({
			ok: false,
			invalid: ["United States", "U", "US-", "US-TOOLONG", "*"],
		});
	});

	test("a legacy non-array shape is refused as a whole", () => {
		expect(parseShippingRegions("US")).toEqual({ ok: false, invalid: ["US"] });
		expect(parseShippingRegions({ country: "US" })).toEqual({ ok: false, invalid: ["[object]"] });
		expect(parseShippingRegions(["US", 7])).toEqual({ ok: false, invalid: ["7"] });
	});
});

describe("resolveShippingZone — the zone is derived from the address, never chosen", () => {
	const zones = [
		zone("z-us", ["US"]),
		zone("z-us-west", ["US-CA", "US-OR", "US-WA"]),
		zone("z-eu", ["FR", "DE"]),
		zone("z-none", null),
	];

	test("a country code matches the zone that lists it", () => {
		const r = resolveShippingZone(zones, { country: "FR" });
		expect(r).toEqual({ ok: true, zone: zones[2] });
	});

	test("matching is case- and whitespace-insensitive on the address side too", () => {
		expect(resolveShippingZone(zones, { country: " de " })).toMatchObject({
			ok: true,
			zone: { id: "z-eu" },
		});
	});

	test("a subdivision entry beats a whole-country entry for an address in that region", () => {
		expect(resolveShippingZone(zones, { country: "US", region: "CA" })).toMatchObject({
			ok: true,
			zone: { id: "z-us-west" },
		});
		// The address may carry the full ISO 3166-2 code as its region.
		expect(resolveShippingZone(zones, { country: "US", region: "us-wa" })).toMatchObject({
			ok: true,
			zone: { id: "z-us-west" },
		});
	});

	test("an address in another region of the country falls back to the whole-country zone", () => {
		expect(resolveShippingZone(zones, { country: "US", region: "NY" })).toMatchObject({
			ok: true,
			zone: { id: "z-us" },
		});
		expect(resolveShippingZone(zones, { country: "US" })).toMatchObject({
			ok: true,
			zone: { id: "z-us" },
		});
	});

	test("an address no zone lists is NO_ZONE_FOR_ADDRESS — never a silent default zone", () => {
		expect(resolveShippingZone(zones, { country: "JP" })).toEqual({
			ok: false,
			reason: "NO_ZONE_FOR_ADDRESS",
		});
		// A country NAME is not a code: it matches nothing rather than being guessed at.
		expect(resolveShippingZone(zones, { country: "France" })).toEqual({
			ok: false,
			reason: "NO_ZONE_FOR_ADDRESS",
		});
		expect(resolveShippingZone([], { country: "US" })).toEqual({
			ok: false,
			reason: "NO_ZONE_FOR_ADDRESS",
		});
	});

	test("a region-only entry never matches an address in a different country", () => {
		expect(resolveShippingZone([zone("z-ca", ["US-CA"])], { country: "CA" })).toEqual({
			ok: false,
			reason: "NO_ZONE_FOR_ADDRESS",
		});
	});

	test("two zones listing the same entry resolve deterministically to the lowest zone id, in any input order", () => {
		const a = zone("z-a", ["GB"]);
		const b = zone("z-b", ["GB"]);
		expect(resolveShippingZone([b, a], { country: "GB" })).toMatchObject({ zone: { id: "z-a" } });
		expect(resolveShippingZone([a, b], { country: "GB" })).toMatchObject({ zone: { id: "z-a" } });
	});

	test("a malformed token in a zone never matches, but the zone's well-formed tokens still do", () => {
		const legacy = zone("z-legacy", ["United Kingdom", "IE"]);
		expect(resolveShippingZone([legacy], { country: "IE" })).toMatchObject({
			zone: { id: "z-legacy" },
		});
		expect(resolveShippingZone([legacy], { country: "United Kingdom" })).toEqual({
			ok: false,
			reason: "NO_ZONE_FOR_ADDRESS",
		});
	});
});
