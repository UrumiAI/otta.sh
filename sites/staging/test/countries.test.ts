/**
 * ADR-0021: the delivery country is a SELECT of ISO 3166-1 codes (the plugin's
 * bundled CLDR list), labelled through `Intl.DisplayNames`. The label is a
 * convenience: if the runtime cannot name a region, the bare code is shown —
 * the page never breaks for want of a label.
 */
import { COUNTRY_CODES } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { countryOptions } from "../src/lib/countries.js";

describe("countryOptions", () => {
	test("every ISO code once, labelled by Intl, sorted by label", () => {
		const options = countryOptions("en");
		expect(options).toHaveLength(COUNTRY_CODES.size);
		expect(options).toContainEqual({ code: "US", label: "United States" });
		expect(options).toContainEqual({ code: "DE", label: "Germany" });
		const labels = options.map((o) => o.label);
		expect(labels).toEqual(labels.toSorted((a, b) => a.localeCompare(b, "en")));
	});

	test("a factory that THROWS falls back to the bare codes", () => {
		const options = countryOptions("en", () => {
			throw new RangeError("no DisplayNames here");
		});
		expect(options.find((o) => o.code === "US")?.label).toBe("US");
	});

	test("a factory whose names come back undefined falls back to the bare code, per entry", () => {
		const options = countryOptions("en", () => ({
			of: (code: string) => (code === "DE" ? "Deutschland" : undefined),
		}));
		expect(options.find((o) => o.code === "DE")?.label).toBe("Deutschland");
		expect(options.find((o) => o.code === "US")?.label).toBe("US");
	});
});
