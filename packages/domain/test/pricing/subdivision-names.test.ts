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

	test("names EVERY subdivision — provisional CLDR names included (CN-HK, CN-MO, CN-NM, CN-TW)", () => {
		// They are `draft="provisional"` in CLDR 48.2's en.xml. A future CLDR
		// release that leaves one unnamed fails here rather than shipping a bare code.
		const unnamed: string[] = [];
		for (const country of SUBDIVISIONS.keys()) {
			for (const o of subdivisionOptions(country)) {
				if (o.name === o.code) unnamed.push(`${country}-${o.code}`);
			}
		}
		expect(unnamed).toEqual([]);
		expect(subdivisionName("CN", "HK")).toBe("Hong Kong");
		expect(subdivisionName("CN", "TW")).toBe("Taiwan");
	});

	test("shows no CLDR footnote marker, and never the same label twice within a country", () => {
		expect(subdivisionName("FR", "IDF")).toBe("Île-de-France");
		for (const country of SUBDIVISIONS.keys()) {
			const labels = subdivisionOptions(country).map((o) => o.name);
			expect(new Set(labels).size, country).toBe(labels.length);
			for (const label of labels) expect(label, country).not.toMatch(/[¹²³⁰⁴-⁹]/u);
		}
		// Told apart by the stripped marker only: each is labelled with its code.
		expect(subdivisionName("EE", "897")).toBe("Viljandi (897)");
		expect(subdivisionName("EE", "899")).toBe("Viljandi (899)");
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
