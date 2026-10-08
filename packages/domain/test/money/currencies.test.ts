import { describe, expect, test } from "vitest";
import {
	SUPPORTED_CURRENCIES,
	currencyDigits,
	currencyInfo,
	isSupportedCurrency,
	type SupportedCurrencyCode,
} from "../../src/index.js";

/**
 * Where ISO 4217 (the table's source) and the runtime's ICU/CLDR data disagree
 * about a listed currency's minor unit, each with its reason. The table follows
 * ISO, and every Otta money boundary reads the TABLE, so these never make two
 * screens disagree — this list exists so a disagreement is a reviewed fact and
 * any NEW one (an ICU upgrade, a new row) fails the parity test below.
 *
 * Observed on Node 22 / ICU 78.3 (CLDR 48), where `Intl.NumberFormat`'s
 * `maximumFractionDigits` is 0 for all four; ISO 4217 List One (2026-09-17)
 * gives 2. CLDR's own data keeps 2 as the accounting digits for some of them and
 * 0 as the cash/display digits; Stripe charges all four as two-decimal
 * (docs.stripe.com/currencies), which is why the table must not follow ICU here.
 */
const ICU_DIVERGES_FROM_ISO: Readonly<Record<string, string>> = {
	COP: "ISO 4217: 2 (centavo); CLDR displays 0",
	HUF: "ISO 4217: 2 (fillér, withdrawn coins); CLDR displays 0",
	IDR: "ISO 4217: 2 (sen); CLDR displays 0",
	PKR: "ISO 4217: 2 (paisa); CLDR displays 0",
};

function icuDigits(code: string): number | undefined {
	return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
		.maximumFractionDigits;
}

describe("the currency table", () => {
	test("covers at least the top forty currencies, each once, upper-case ISO alpha codes", () => {
		expect(SUPPORTED_CURRENCIES.length).toBeGreaterThanOrEqual(40);
		const codes = SUPPORTED_CURRENCIES.map((row) => row.code);
		expect(new Set(codes).size).toBe(codes.length);
		for (const code of codes) expect(code, code).toMatch(/^[A-Z]{3}$/);
		// Sorted, so a person adding a row knows where it goes and a duplicate is
		// visible beside its twin.
		expect(codes).toEqual([...codes].toSorted());
	});

	test("every row's digits is an ISO 4217 exponent a money boundary handles: 0, 2 or 3", () => {
		for (const row of SUPPORTED_CURRENCIES) expect([0, 2, 3], row.code).toContain(row.digits);
	});

	test("every row has a name and a symbol to show", () => {
		for (const row of SUPPORTED_CURRENCIES) {
			expect(row.name.trim().length, row.code).toBeGreaterThan(0);
			expect(row.symbol.trim().length, row.code).toBeGreaterThan(0);
		}
	});

	test("every row's digits matches the runtime's ICU data, except the commented ISO-vs-CLDR divergences", () => {
		const mismatches = SUPPORTED_CURRENCIES.filter(
			(row) => icuDigits(row.code) !== row.digits && !(row.code in ICU_DIVERGES_FROM_ISO),
		).map((row) => `${row.code}: table ${String(row.digits)}, ICU ${String(icuDigits(row.code))}`);
		expect(mismatches).toEqual([]);
	});

	test("every listed divergence is still real and still in the table (no stale exceptions)", () => {
		for (const code of Object.keys(ICU_DIVERGES_FROM_ISO)) {
			const row = currencyInfo(code);
			expect(row, code).toBeDefined();
			expect(icuDigits(code), code).not.toBe(row?.digits);
		}
	});

	test("pins the exponents that decide what a typed amount means", () => {
		const expected: Record<string, number> = {
			USD: 2,
			EUR: 2,
			GBP: 2,
			INR: 2,
			JPY: 0,
			KRW: 0,
			VND: 0,
			CLP: 0,
			ISK: 0,
			KWD: 3,
			BHD: 3,
			OMR: 3,
			JOD: 3,
			HUF: 2,
			TWD: 2,
		};
		for (const [code, digits] of Object.entries(expected)) {
			expect(currencyDigits(code), code).toBe(digits);
		}
	});
});

describe("isSupportedCurrency / currencyDigits", () => {
	test("a listed code is supported and has its digits; anything else is not, and has none", () => {
		expect(isSupportedCurrency("USD")).toBe(true);
		expect(isSupportedCurrency("JPY")).toBe(true);
		for (const code of ["XYZ", "usd", " USD", "", "US", "LKR", "XDR", "BGN"]) {
			expect(isSupportedCurrency(code), code).toBe(false);
			expect(currencyDigits(code), code).toBeUndefined();
			expect(currencyInfo(code), code).toBeUndefined();
		}
	});

	test("narrows to the derived code union", () => {
		const code: string = "EUR";
		if (isSupportedCurrency(code)) {
			const narrowed: SupportedCurrencyCode = code;
			expect(narrowed).toBe("EUR");
		}
	});
});
