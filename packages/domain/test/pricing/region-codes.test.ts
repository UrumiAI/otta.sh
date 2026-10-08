import { describe, expect, test } from "vitest";
import { COUNTRY_CODES, SUBDIVISIONS } from "../../src/pricing/iso-3166.generated.js";
import {
	isCodeShapedRegion,
	normalizeCountryCode,
	normalizeSubdivision,
	parseZoneRegions,
	REGION_CODE_PATTERN,
	validateZoneRegionsInput,
} from "../../src/pricing/region-codes.js";

/**
 * ADR-0021: countries are ISO 3166-1 alpha-2 and subdivisions ISO 3166-2, both
 * from the pinned CLDR release (48.2). The FIRST thing pinned here is that the
 * bundled data actually contains every code the rest of the suite leans on — a
 * CLDR refresh that dropped one of them must fail here, loudly, rather than
 * turn a pricing test into a confusing "unmatched".
 */
describe("the bundled CLDR data carries every code the suites use", () => {
	test.each([
		["US", "CA"],
		["US", "TX"],
		["US", "NY"],
		["DE", "BY"],
		["GB", "LND"],
		["FR", "75C"],
		["FR", "IDF"],
		["CA", "ON"],
	])("%s-%s is a regular subdivision", (country, sub) => {
		expect(COUNTRY_CODES.has(country)).toBe(true);
		expect(SUBDIVISIONS.get(country)?.has(sub)).toBe(true);
	});

	test("XK is accepted as a country (D11); EU, UN, ZZ and UK are not", () => {
		expect(COUNTRY_CODES.has("XK")).toBe(true);
		for (const code of ["EU", "UN", "ZZ", "UK", "QO", "AA"]) {
			expect(COUNTRY_CODES.has(code), code).toBe(false);
		}
	});

	// CLDR "regular" is wider than ISO 3166-1 "officially assigned": it also
	// lists the EXCEPTIONALLY RESERVED codes. An order to one could be minted and
	// then refused by the payment provider, so the generator excludes them.
	test.each(["AC", "CP", "CQ", "DG", "EA", "IC", "TA"])(
		"%s (ISO 3166-1 exceptionally reserved) is NOT a country",
		(code) => {
			expect(COUNTRY_CODES.has(code)).toBe(false);
			expect(SUBDIVISIONS.has(code)).toBe(false);
		},
	);

	test("officially assigned territories stay (AQ, BV, HM, UM), and the set is the 249 assigned codes plus XK", () => {
		for (const code of ["AQ", "BV", "HM", "UM", "XK"])
			expect(COUNTRY_CODES.has(code), code).toBe(true);
		expect(COUNTRY_CODES.size).toBe(250);
	});

	test("every subdivision's country is itself a country code", () => {
		for (const country of SUBDIVISIONS.keys())
			expect(COUNTRY_CODES.has(country), country).toBe(true);
	});
});

describe("normalizeCountryCode", () => {
	test('" us " → US; XK accepted', () => {
		expect(normalizeCountryCode(" us ")).toBe("US");
		expect(normalizeCountryCode("XK")).toBe("XK");
	});

	test.each(["UK", "EU", "UN", "ZZ", "USA", "", "  ", "United States", "U S"])(
		"%j → null",
		(raw) => {
			expect(normalizeCountryCode(raw)).toBeNull();
		},
	);
});

describe("normalizeSubdivision", () => {
	test("(US, ca) and (US, US-CA) → CA — the canonical bare code (D13)", () => {
		expect(normalizeSubdivision("US", "ca")).toEqual({ ok: true, code: "CA" });
		expect(normalizeSubdivision("US", " US-CA ")).toEqual({ ok: true, code: "CA" });
		expect(normalizeSubdivision("US", "us-ca")).toEqual({ ok: true, code: "CA" });
	});

	test("(DE, by) → BY; (FR, 75c) → 75C", () => {
		expect(normalizeSubdivision("DE", "by")).toEqual({ ok: true, code: "BY" });
		expect(normalizeSubdivision("FR", "75c")).toEqual({ ok: true, code: "75C" });
	});

	test("blank, whitespace, null and undefined → null (no region)", () => {
		expect(normalizeSubdivision("US", "")).toEqual({ ok: true, code: null });
		expect(normalizeSubdivision("US", "   ")).toEqual({ ok: true, code: null });
		expect(normalizeSubdivision("US", null)).toEqual({ ok: true, code: null });
		expect(normalizeSubdivision("US", undefined)).toEqual({ ok: true, code: null });
	});

	test.each([
		["US", "XX"],
		["US", "MX-CA"],
		["DE", "Bavaria"],
		["US", "US_CA"],
		["US", "California"],
		["ZZ", "CA"],
	])("(%s, %j) is refused", (country, raw) => {
		expect(normalizeSubdivision(country, raw)).toEqual({ ok: false });
	});

	test("a country with no subdivisions in CLDR refuses any non-blank region", () => {
		expect(SUBDIVISIONS.has("XK")).toBe(false);
		expect(normalizeSubdivision("XK", "01")).toEqual({ ok: false });
		expect(normalizeSubdivision("XK", "")).toEqual({ ok: true, code: null });
	});
});

describe("isCodeShapedRegion — the one SHAPE rule the routes and the site share", () => {
	test.each(["CA", "us-ca", "75C", "LND", "1"])("accepts %j", (raw) => {
		expect(isCodeShapedRegion(raw)).toBe(true);
	});

	test.each(["US_CA", "California", "ABCD", "", "US-", "-CA", "U-CA", "US-ABCD", "C A"])(
		"rejects %j",
		(raw) => {
			expect(isCodeShapedRegion(raw)).toBe(false);
		},
	);

	test("shape only: a code-shaped fake passes (membership is the domain's job)", () => {
		expect(isCodeShapedRegion("XX")).toBe(true);
	});
});

describe("parseZoneRegions — lenient, for stored (possibly legacy) zones", () => {
	test('legacy ["United States","us"] → codes ["US"], invalid ["United States"]', () => {
		expect(parseZoneRegions(["United States", "us"])).toEqual({
			codes: ["US"],
			invalid: ["United States"],
		});
	});

	test("subdivision codes are kept in full form, uppercased", () => {
		expect(parseZoneRegions([" us-ca ", "DE"])).toEqual({ codes: ["US-CA", "DE"], invalid: [] });
	});

	test("a code-shaped fake subdivision is invalid (never matches)", () => {
		expect(parseZoneRegions(["US-XX"])).toEqual({ codes: [], invalid: ["US-XX"] });
	});

	test.each([null, undefined, "US", 42, { US: true }])("non-array %j → no codes", (raw) => {
		expect(parseZoneRegions(raw)).toEqual({ codes: [], invalid: [] });
	});

	test("non-string entries are invalid, stringified", () => {
		expect(parseZoneRegions(["US", 7])).toEqual({ codes: ["US"], invalid: ["7"] });
	});
});

describe("validateZoneRegionsInput — strict, for the admin's writes", () => {
	test('" FR , de " → ["FR","DE"]', () => {
		expect(validateZoneRegionsInput(" FR , de ")).toEqual({ ok: true, codes: ["FR", "DE"] });
	});

	test("dedupes, case-insensitively, keeping first-seen order", () => {
		expect(validateZoneRegionsInput("us, US-CA, US, us-ca")).toEqual({
			ok: true,
			codes: ["US", "US-CA"],
		});
	});

	test("blank → null (no regions)", () => {
		expect(validateZoneRegionsInput("")).toEqual({ ok: true, codes: null });
		expect(validateZoneRegionsInput(" , ,")).toEqual({ ok: true, codes: null });
	});

	test("reports every bad token, as typed", () => {
		expect(validateZoneRegionsInput("UK, United States, US-XX, US")).toEqual({
			ok: false,
			invalid: ["UK", "United States", "US-XX"],
		});
	});
});

describe("REGION_CODE_PATTERN — the shape rule, for a form field's pattern", () => {
	test("the pattern IS the shape rule: anchored, it accepts exactly what isCodeShapedRegion does", () => {
		const anchored = new RegExp(`^(?:${REGION_CODE_PATTERN})$`);
		for (const code of ["CA", "ca", "US-CA", "us-ca", "D13", "GB-ENG", "1", "XX"]) {
			expect(anchored.test(code), code).toBe(true);
			expect(isCodeShapedRegion(code), code).toBe(true);
		}
		for (const code of ["", "California", "US-CALI", "U-CA", "C A", "ABCD"]) {
			expect(anchored.test(code), code).toBe(false);
			expect(isCodeShapedRegion(code), code).toBe(false);
		}
	});
});
