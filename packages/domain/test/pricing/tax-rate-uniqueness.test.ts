import { describe, expect, test } from "vitest";
import {
	appliedTaxRate,
	effectiveTaxRates,
	isTaxRateDuplicateError,
	shadowedTaxRates,
	TaxRateDuplicateError,
	type TaxRate,
} from "../../src/index.js";
import { rateTableOf } from "../../src/pricing/rate-table-calculator.js";

function rate(
	id: string,
	taxClassId: string,
	zoneId: string,
	rateBps = 1000,
	appliesToShipping = false,
): TaxRate {
	return { id, taxClassId, zoneId, rateBps, appliesToShipping };
}

describe("one tax rate per (class, zone) — the rule", () => {
	test("a duplicate is the same class AND the same zone; rate and shipping flag do not matter", () => {
		const rates = [
			rate("a", "standard", "z-us", 700, true),
			rate("b", "standard", "z-us", 900, false),
			rate("c", "standard", "z-eu"),
			rate("d", "reduced", "z-us"),
		];
		expect([...shadowedTaxRates(rates).entries()].map(([id, w]) => [id, w.id])).toEqual([
			["a", "b"],
		]);
	});

	test("the greatest id applies, whatever order the rates arrive in", () => {
		const forwards = [
			rate("r-1", "standard", "z"),
			rate("r-2", "standard", "z"),
			rate("r-10", "standard", "z"),
		];
		const backwards = forwards.toReversed();
		// Code-unit order: "r-2" > "r-10" > "r-1" — the order the store lists rates in.
		expect(appliedTaxRate(forwards, "standard", "z")?.id).toBe("r-2");
		expect(appliedTaxRate(backwards, "standard", "z")?.id).toBe("r-2");
		expect(effectiveTaxRates(forwards).map((r) => r.id)).toEqual(["r-2"]);
		expect(effectiveTaxRates(backwards).map((r) => r.id)).toEqual(["r-2"]);
	});

	test("it is the rate main's checkout already charged: the last listed by id", () => {
		const listed = [rate("a", "standard", "z", 700), rate("b", "standard", "z", 900)];
		expect(appliedTaxRate(listed, "standard", "z")?.rateBps).toBe(900);
		expect(rateTableOf(listed).ratesByClass.get("standard")).toBe(900);
	});

	test("effectiveTaxRates keeps the input order of what survives", () => {
		const rates = [
			rate("s1", "standard", "z", 1000, true),
			rate("r1", "reduced", "z", 500, true),
			rate("s2", "standard", "z", 1100, false),
		];
		expect(effectiveTaxRates(rates).map((r) => r.id)).toEqual(["r1", "s2"]);
	});

	test("no duplicates: nothing is shadowed and every rate is effective", () => {
		const rates = [
			rate("a", "standard", "z-us"),
			rate("b", "standard", "z-eu"),
			rate("c", "zero", "z-us"),
		];
		expect(shadowedTaxRates(rates).size).toBe(0);
		expect(effectiveTaxRates(rates)).toEqual(rates);
		expect(appliedTaxRate(rates, "standard", "z-eu")?.id).toBe("b");
		expect(appliedTaxRate(rates, "standard", "z-nowhere")).toBeNull();
	});

	test("an ignored duplicate is ignored entirely — its shipping flag included", () => {
		// "a" is the ignored one and the only rate flagged for shipping. Main's loop let
		// that flag tax shipping at "b"'s rate; now the zone does not tax shipping, as
		// "only b applies" says.
		const table = rateTableOf([
			rate("a", "standard", "z", 700, true),
			rate("b", "standard", "z", 900, false),
		]);
		expect(table.ratesByClass.get("standard")).toBe(900);
		expect(table.shippingTaxable).toBe(false);
		// The applied rate's own flag still taxes shipping.
		const flagged = rateTableOf([
			rate("a", "standard", "z", 700, false),
			rate("b", "standard", "z", 900, true),
		]);
		expect(flagged.shippingTaxable).toBe(true);
		expect(flagged.shippingTaxClassId).toBe("standard");
	});

	test("the duplicate error names the existing rate and is recognised structurally", () => {
		const err = new TaxRateDuplicateError(rate("std-us", "standard", "z-us", 725));
		expect(err).toMatchObject({
			code: "TAX_RATE_DUPLICATE",
			taxClassId: "standard",
			zoneId: "z-us",
			existingRateId: "std-us",
			existingRateBps: 725,
		});
		expect(isTaxRateDuplicateError(err)).toBe(true);
		// A plain object with the code (as it would cross a sandbox bridge) passes too.
		expect(isTaxRateDuplicateError({ code: "TAX_RATE_DUPLICATE" })).toBe(true);
		expect(isTaxRateDuplicateError(new Error("x"))).toBe(false);
		expect(isTaxRateDuplicateError(null)).toBe(false);
	});
});
