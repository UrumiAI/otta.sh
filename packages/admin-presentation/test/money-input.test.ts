/**
 * The money text inputs read and write amounts in the CURRENCY's own minor unit
 * (the currency table, `src/currencies.ts`): what was typed is what is stored,
 * and what is stored is what `formatMoney` shows.
 *
 * Two-decimal currencies keep the behaviour they always had — the plugin's
 * `shipping-rate-money.test.ts` and `product-edit-money.test.ts` pin that, with
 * their original expectations, for USD; the matrix below adds EUR beside it.
 */
import { describe, expect, test } from "vitest";
import {
	canonicalMoneyInput,
	cents,
	currency,
	formatAmount,
	formatMinorUnitsInput,
	formatMoney,
	hasExcessDecimals,
	majorUnits,
	minorUnitDigits,
	inputMinorUnitDigits,
	moneyInputExample,
	moneyPrecisionPhrase,
	NO_CURRENCY,
	parseMinorUnitsInput,
	REFUND_AMOUNT_PRECISION,
	refundAmountPrecisionText,
	unsupportedCurrencyMessage,
} from "../src/index.js";
import { FORMAT_CACHE_CAP, formatCacheSize } from "../src/format-money.js";

/** Intl separates a code from the number with a NO-BREAK SPACE; the
 *  assertions below are about digits, so they compare with a plain one. */
const plain = (s: string): string => s.replace(/\u00a0/g, " ");

const parse = (input: string, code: string, allowZero = true): number | null =>
	parseMinorUnitsInput(input, code, { allowZero });

describe("parseMinorUnitsInput — the accept/reject matrix by exponent", () => {
	// [input, zero-decimal (JPY, KRW), two-decimal (USD, EUR), three-decimal (KWD, BHD)]
	const MATRIX: ReadonlyArray<readonly [string, number | null, number | null, number | null]> = [
		["1500", 1500, 150_000, 1_500_000],
		["15.5", null, 1550, 15_500],
		["15.50", null, 1550, 15_500],
		["15.505", null, null, 15_505],
		["15.5055", null, null, null],
		[" 1500 ", 1500, 150_000, 1_500_000],
		["\t15.5\n", null, 1550, 15_500],
		["0", 0, 0, 0],
		["1.", null, null, null],
		[".5", null, null, null],
		["-1", null, null, null],
		["1,500", null, null, null],
		["1e3", null, null, null],
		["", null, null, null],
		["abc", null, null, null],
	];

	for (const [input, zero, two, three] of MATRIX) {
		test(`${JSON.stringify(input)} → JPY/KRW ${String(zero)}, USD/EUR ${String(two)}, KWD/BHD ${String(three)}`, () => {
			for (const code of ["JPY", "KRW"]) expect(parse(input, code), code).toBe(zero);
			for (const code of ["USD", "EUR"]) expect(parse(input, code), code).toBe(two);
			for (const code of ["KWD", "BHD"]) expect(parse(input, code), code).toBe(three);
		});
	}

	test("zero is refused when the caller says so, in every exponent", () => {
		for (const code of ["JPY", "USD", "KWD"]) {
			expect(parse("0", code, false), code).toBeNull();
			expect(parse("1", code, false), code).not.toBeNull();
		}
	});

	test("an amount past the safe-integer range is refused, never rounded (never throws)", () => {
		// 2^53 itself, and a major amount that only overflows once scaled.
		expect(parse("9007199254740992", "JPY")).toBeNull();
		expect(parse("9007199254740991", "JPY")).toBe(Number.MAX_SAFE_INTEGER);
		expect(parse("90071992547410", "USD")).toBeNull();
		expect(parse("9007199254741", "KWD")).toBeNull();
		expect(parse("9".repeat(400), "USD")).toBeNull();
	});

	test("no currency (a legacy percentage coupon's cap) keeps the hundredths scale", () => {
		expect(parse("20", NO_CURRENCY)).toBe(2000);
		expect(parse("20.5", NO_CURRENCY)).toBe(2050);
		expect(parse("20.505", NO_CURRENCY)).toBeNull();
	});

	test("a code OUTSIDE the table is typed in hundredths, exactly as before the table — whatever ICU says", () => {
		// ALL and ISK: ICU displays them with 0 decimals, but every amount ever
		// typed in them was stored ×100 (and Stripe takes them as two-decimal), so
		// input must keep that meaning. LKR: two decimals either way.
		for (const code of ["ALL", "ISK", "UGX", "LKR"]) {
			expect(parse("1500.00", code), code).toBe(150_000);
			expect(parse("15.5", code), code).toBe(1550);
			expect(parse("15.505", code), code).toBeNull();
			expect(formatMinorUnitsInput(150_000, code), code).toBe("1500.00");
			expect(canonicalMoneyInput("1500", code), code).toBe("1500.00");
			expect(hasExcessDecimals("7.001", code), code).toBe(true);
			expect(hasExcessDecimals("7.01", code), code).toBe(false);
			expect(refundAmountPrecisionText(code), code).toBe(REFUND_AMOUNT_PRECISION);
			expect(moneyPrecisionPhrase(code), code).toBe("up to two decimal places");
			expect(moneyInputExample("19.99", code), code).toBe("19.99");
			expect(inputMinorUnitDigits(code), code).toBe(2);
		}
	});
});

describe("formatMinorUnitsInput — the inverse, in the currency's exponent", () => {
	test("renders each exponent with exactly its digits, no symbol", () => {
		expect(formatMinorUnitsInput(1500, "JPY")).toBe("1500");
		expect(formatMinorUnitsInput(0, "KRW")).toBe("0");
		expect(formatMinorUnitsInput(1550, "USD")).toBe("15.50");
		expect(formatMinorUnitsInput(5, "EUR")).toBe("0.05");
		expect(formatMinorUnitsInput(15_505, "KWD")).toBe("15.505");
		expect(formatMinorUnitsInput(5, "BHD")).toBe("0.005");
		expect(formatMinorUnitsInput(0, "OMR")).toBe("0.000");
		expect(formatMinorUnitsInput(-1234, "KWD")).toBe("-1.234");
	});

	test("format ∘ parse is the identity, for every exponent", () => {
		for (const code of ["JPY", "KRW", "USD", "EUR", "KWD", "BHD", "ISK", "ALL", "HUF"]) {
			for (const units of [0, 1, 9, 10, 99, 100, 999, 1000, 1500, 15_505, 1_000_000]) {
				expect(parse(formatMinorUnitsInput(units, code), code), `${code} ${String(units)}`).toBe(
					units,
				);
			}
		}
	});

	test("canonicalMoneyInput spells one amount one way, per currency", () => {
		expect(canonicalMoneyInput("15.5", "USD")).toBe("15.50");
		expect(canonicalMoneyInput("15.5", "KWD")).toBe("15.500");
		expect(canonicalMoneyInput(" 1500 ", "JPY")).toBe("1500");
		// Not a validator: an entry the currency cannot hold is handed back.
		expect(canonicalMoneyInput("15.5", "JPY")).toBe("15.5");
	});
});

describe("display reads the SAME exponent the inputs parse with", () => {
	test("what is typed is what is shown: JPY 1500, KWD 1.234, USD 15.00", () => {
		expect(formatMoney(cents(parse("1500", "JPY") ?? -1), currency("JPY"), "en-US")).toBe("¥1,500");
		expect(plain(formatMoney(cents(parse("1.234", "KWD") ?? -1), currency("KWD"), "en-US"))).toBe(
			"KWD 1.234",
		);
		expect(formatMoney(cents(parse("15", "USD") ?? -1), currency("USD"), "en-US")).toBe("$15.00");
	});

	test("where ICU's exponent differs from ISO's (HUF), the table's wins — no stored minor unit is rounded away", () => {
		expect(minorUnitDigits("HUF")).toBe(2);
		expect(plain(formatMoney(cents(150_050), currency("HUF"), "en-US"))).toBe("HUF 1,500.50");
		expect(majorUnits(cents(150_050), currency("HUF"))).toBe("1500.50");
		expect(plain(formatAmount(150_000, "IDR"))).toBe("IDR 1,500.00");
	});

	test("a code outside the table renders exactly as before (ICU's exponent)", () => {
		expect(minorUnitDigits("LKR")).toBe(2);
		expect(minorUnitDigits("UGX")).toBe(0);
		expect(plain(formatAmount(1500, "UGX"))).toBe("UGX 1,500");
		expect(plain(formatAmount(150_000, "ISK"))).toBe("ISK 150,000");
	});
});

describe("the copy that states a currency's precision", () => {
	test("two decimals reads as it always did; zero and three say their own rule", () => {
		expect(moneyPrecisionPhrase("USD")).toBe("up to two decimal places");
		expect(moneyPrecisionPhrase(NO_CURRENCY)).toBe("up to two decimal places");
		expect(moneyPrecisionPhrase("JPY")).toBe("whole numbers only");
		expect(moneyPrecisionPhrase("KWD")).toBe("up to three decimal places");
	});

	test("the refund form's excess-decimals check and sentence follow the order's currency", () => {
		expect(hasExcessDecimals("7.001", "USD")).toBe(true);
		expect(hasExcessDecimals("7.001", "KWD")).toBe(false);
		expect(hasExcessDecimals("7.0001", "KWD")).toBe(true);
		expect(hasExcessDecimals("7.5", "JPY")).toBe(true);
		expect(hasExcessDecimals("7", "JPY")).toBe(false);
		expect(refundAmountPrecisionText("USD")).toBe(REFUND_AMOUNT_PRECISION);
		expect(refundAmountPrecisionText("JPY")).toMatch(/whole number/);
		expect(refundAmountPrecisionText("KWD")).toMatch(/up to three decimal places/);
	});

	test("an unsupported-currency message with or without a code", () => {
		expect(unsupportedCurrencyMessage("XYZ")).toMatch(/^XYZ isn't a supported currency/);
		expect(unsupportedCurrencyMessage()).toMatch(/^That isn't a supported currency/);
	});

	test("one example builder: the two-decimal example as typed for USD, reshaped for JPY and KWD", () => {
		expect(moneyInputExample("19.99", "USD")).toBe("19.99");
		expect(moneyInputExample("35.00", "JPY")).toBe("3500");
		expect(moneyInputExample("9.50", "KWD")).toBe("9.500");
		expect(moneyInputExample("4.99", NO_CURRENCY)).toBe("4.99");
	});
});

describe("formatMoney's formatter cache is bounded", () => {
	test("1,000 client-chosen locales cache nothing; output is unchanged", () => {
		const before = formatCacheSize();
		for (let n = 0; n < 1000; n++) {
			expect(formatMoney(cents(1999), currency("USD"), `en-x-${String(n)}`)).toBe(
				formatMoney(cents(1999), currency("USD"), "en-US"),
			);
		}
		// At most the one fixed-locale (en-US) formatter the comparison itself adds.
		expect(formatCacheSize()).toBeLessThanOrEqual(before + 1);
		expect(formatCacheSize()).toBeLessThanOrEqual(FORMAT_CACHE_CAP);
	});

	test("the fixed locales are cached, and the cache never exceeds its cap", () => {
		for (let n = 0; n < 26 * 26; n++) {
			const code = `X${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n % 26))}`;
			formatMoney(cents(1), currency(code), "en-US");
			expect(formatCacheSize()).toBeLessThanOrEqual(FORMAT_CACHE_CAP);
		}
		expect(plain(formatMoney(cents(1999), currency("USD"), "en-US"))).toBe("$19.99");
	});
});
