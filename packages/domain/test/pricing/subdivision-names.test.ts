import { describe, expect, test } from "vitest";
import { SUBDIVISIONS } from "../../src/pricing/iso-3166.generated.js";
import { normalizeSubdivision } from "../../src/pricing/region-codes.js";
import { subdivisionName, subdivisionOptions } from "../../src/pricing/subdivision-names.js";

describe("subdivisionOptions", () => {
	test("lists a country's subdivisions with their English names, by code", () => {
		const us = subdivisionOptions("US");
		expect(us.find((o) => o.code === "CA")).toEqual({ code: "CA", name: "California" });
		const codes = us.map((o) => o.code);
		expect(codes).toEqual(codes.toSorted());
		expect(subdivisionOptions("in").find((o) => o.code === "KA")?.name).toBe("Karnataka");
	});

	test("lists EXACTLY the codes validation accepts — no more, no fewer — for every country", () => {
		for (const [country, codes] of SUBDIVISIONS) {
			const listed = subdivisionOptions(country).map((o) => o.code);
			expect(listed, country).toEqual([...codes].toSorted());
			for (const code of listed) {
				expect(normalizeSubdivision(country, code), `${country}-${code}`).toEqual({
					ok: true,
					code,
				});
			}
		}
	});

	test("labels a subdivision CLDR names nothing in English with its code", () => {
		// CN-HK, CN-MO, CN-NM and CN-TW are regular codes with no English name in CLDR 48.2.
		expect(subdivisionOptions("CN").find((o) => o.code === "HK")).toEqual({
			code: "HK",
			name: "HK",
		});
	});

	test("is empty for a country without subdivisions and for a non-country", () => {
		expect(SUBDIVISIONS.has("AQ")).toBe(false);
		expect(subdivisionOptions("AQ")).toEqual([]);
		expect(subdivisionOptions("ZZ")).toEqual([]);
		expect(subdivisionOptions("")).toEqual([]);
		expect(subdivisionOptions("__proto__")).toEqual([]);
	});

	test("ignores case and spaces, and hands back the same frozen list each time", () => {
		const first = subdivisionOptions(" us ");
		expect(subdivisionOptions("US")).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first[0])).toBe(true);
	});
});

describe("subdivisionName", () => {
	test("names a bare or own-country-prefixed code in any case", () => {
		expect(subdivisionName("US", "CA")).toBe("California");
		expect(subdivisionName("us", "us-ca")).toBe("California");
		expect(subdivisionName("US", "ZZ")).toBeNull();
		expect(subdivisionName("US", "MX-CA")).toBeNull();
	});
});
