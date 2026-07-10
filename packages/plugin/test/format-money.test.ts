import { describe, expect, test } from "vitest";
import { cents, currency } from "../src/presentation/money.js";
import { formatMoney, majorUnits } from "../src/presentation/format-money.js";

/**
 * Phase 2 §7 step 7 — the ONE sanctioned money→display boundary (§4.6):
 * branded `Cents`+`Currency` in, locale-formatted major-unit string out.
 * The minor→major conversion is pure integer string arithmetic — no float
 * ever touches the amount (the decimal string is handed to
 * `Intl.NumberFormat.format`, which accepts exact numeric strings).
 * The compile-time half (a bare `number` must not format) lives in
 * `format-money.type-test.ts`.
 */
describe("formatMoney", () => {
	test("renders a locale-formatted major-unit string for Cents+Currency", () => {
		expect(formatMoney(cents(1999), currency("USD"), "en-US")).toBe("$19.99");
	});

	test("locale drives separators and symbol placement (de-DE)", () => {
		expect(formatMoney(cents(123456), currency("EUR"), "de-DE")).toBe("1.234,56 €");
	});

	test("zero-minor-unit currencies never invent decimals (JPY: minor unit IS the major unit)", () => {
		expect(formatMoney(cents(1999), currency("JPY"), "ja-JP")).toBe("￥1,999");
	});

	test("amounts smaller than one major unit pad correctly", () => {
		expect(formatMoney(cents(5), currency("USD"), "en-US")).toBe("$0.05");
	});

	test("an RTL locale formats without error and carries localized digits (RTL-safe output comes from Intl, not hand-built strings)", () => {
		const formatted = formatMoney(cents(1999), currency("USD"), "ar-EG");
		expect(formatted.length).toBeGreaterThan(0);
		// Arabic-Indic digits — proof this is real locale output, not a template.
		expect(formatted).toMatch(/[٠-٩]/);
	});

	test("amounts near MAX_SAFE_INTEGER stay exact (integer string math, no float rounding)", () => {
		const huge = cents(9007199254740991); // 2^53 - 1
		expect(majorUnits(huge, currency("USD"))).toBe("90071992547409.91");
	});
});

describe("majorUnits (locale-independent decimal string — feeds JSON-LD `price`)", () => {
	test("two-decimal currency", () => {
		expect(majorUnits(cents(1999), currency("USD"))).toBe("19.99");
	});

	test("zero-decimal currency", () => {
		expect(majorUnits(cents(1999), currency("JPY"))).toBe("1999");
	});

	test("sub-unit amounts", () => {
		expect(majorUnits(cents(5), currency("EUR"))).toBe("0.05");
		expect(majorUnits(cents(0), currency("USD"))).toBe("0.00");
	});
});
