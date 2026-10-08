/**
 * THE CURRENCIES A STORE CAN PRICE IN — the one table every money boundary reads
 * its minor-unit exponent from: the admin's money inputs (`"1500"` JPY is 1500,
 * not 150000), money display, the refund flags, and the Stripe adapter's amount
 * mapping.
 *
 * HOW TO ADD A CURRENCY
 *  1. Add a row below: `code` (ISO 4217 alpha), `digits` (ISO 4217's minor-unit
 *     exponent: 0, 2 or 3 — take it from ISO's own list, not from memory), plus a
 *     display `symbol` and English `name`. Keep the rows sorted by code.
 *  2. Copy the SAME row into `packages/admin-presentation/src/currencies.ts` (the
 *     admin surfaces cannot import this package — see that file's header).
 *     `packages/plugin/test/money-parity.test.ts` fails until both tables are
 *     identical, so the copy cannot drift.
 *  3. Run `pnpm test`: `test/money/currencies.test.ts` compares every row's
 *     `digits` with the runtime's ICU data and names any disagreement, and the
 *     Stripe adapter's tests check the row against Stripe's documented
 *     zero-/three-decimal sets. A genuine ISO-vs-ICU divergence goes in that
 *     test's commented exception list.
 *
 * SOURCE. Codes and exponents checked against ISO 4217 List One as published by
 * SIX (the maintenance agency), dated 2026-09-17. Where the runtime's CLDR data
 * disagrees with ISO (HUF, IDR, COP, PKR: CLDR 48 says 0, ISO says 2) the TABLE
 * — ISO — wins everywhere, so a stored amount means the same thing in every
 * screen; the test documents each case.
 *
 * MEMBERSHIP IS FOR WHAT A MERCHANT TYPES. The admin write paths (a product's
 * price currency, a shipping rate's, a fixed coupon's) refuse a code that is not
 * here. READ paths never do: a row stored before this table existed, in any
 * shape-valid code, still loads and still renders (display falls back to the
 * runtime's own exponent for a code that is not listed).
 *
 * Pure data — the domain stays IO-free.
 */

/** One row: what a person edits to add a currency. */
export interface CurrencyInfo {
	/** ISO 4217 alphabetic code, upper case. */
	readonly code: string;
	/** ISO 4217 minor-unit exponent: amounts are stored in units of 10^-digits. */
	readonly digits: 0 | 2 | 3;
	/** A short display symbol (CLDR's narrow symbol where it has one). */
	readonly symbol: string;
	/** English display name. */
	readonly name: string;
}

export const SUPPORTED_CURRENCIES = [
	{ code: "AED", digits: 2, symbol: "AED", name: "United Arab Emirates Dirham" },
	{ code: "ARS", digits: 2, symbol: "$", name: "Argentine Peso" },
	{ code: "AUD", digits: 2, symbol: "$", name: "Australian Dollar" },
	{ code: "BDT", digits: 2, symbol: "৳", name: "Bangladeshi Taka" },
	{ code: "BHD", digits: 3, symbol: "BHD", name: "Bahraini Dinar" },
	{ code: "BRL", digits: 2, symbol: "R$", name: "Brazilian Real" },
	{ code: "CAD", digits: 2, symbol: "$", name: "Canadian Dollar" },
	{ code: "CHF", digits: 2, symbol: "CHF", name: "Swiss Franc" },
	{ code: "CLP", digits: 0, symbol: "$", name: "Chilean Peso" },
	{ code: "CNY", digits: 2, symbol: "¥", name: "Chinese Yuan" },
	{ code: "COP", digits: 2, symbol: "$", name: "Colombian Peso" },
	{ code: "CZK", digits: 2, symbol: "Kč", name: "Czech Koruna" },
	{ code: "DKK", digits: 2, symbol: "kr", name: "Danish Krone" },
	{ code: "EGP", digits: 2, symbol: "E£", name: "Egyptian Pound" },
	{ code: "EUR", digits: 2, symbol: "€", name: "Euro" },
	{ code: "GBP", digits: 2, symbol: "£", name: "British Pound" },
	{ code: "HKD", digits: 2, symbol: "$", name: "Hong Kong Dollar" },
	{ code: "HUF", digits: 2, symbol: "Ft", name: "Hungarian Forint" },
	{ code: "IDR", digits: 2, symbol: "Rp", name: "Indonesian Rupiah" },
	{ code: "ILS", digits: 2, symbol: "₪", name: "Israeli New Shekel" },
	{ code: "INR", digits: 2, symbol: "₹", name: "Indian Rupee" },
	{ code: "ISK", digits: 0, symbol: "kr", name: "Icelandic Króna" },
	{ code: "JOD", digits: 3, symbol: "JOD", name: "Jordanian Dinar" },
	{ code: "JPY", digits: 0, symbol: "¥", name: "Japanese Yen" },
	{ code: "KES", digits: 2, symbol: "KES", name: "Kenyan Shilling" },
	{ code: "KRW", digits: 0, symbol: "₩", name: "South Korean Won" },
	{ code: "KWD", digits: 3, symbol: "KWD", name: "Kuwaiti Dinar" },
	{ code: "MAD", digits: 2, symbol: "MAD", name: "Moroccan Dirham" },
	{ code: "MXN", digits: 2, symbol: "$", name: "Mexican Peso" },
	{ code: "MYR", digits: 2, symbol: "RM", name: "Malaysian Ringgit" },
	{ code: "NGN", digits: 2, symbol: "₦", name: "Nigerian Naira" },
	{ code: "NOK", digits: 2, symbol: "kr", name: "Norwegian Krone" },
	{ code: "NZD", digits: 2, symbol: "$", name: "New Zealand Dollar" },
	{ code: "OMR", digits: 3, symbol: "OMR", name: "Omani Rial" },
	{ code: "PEN", digits: 2, symbol: "PEN", name: "Peruvian Sol" },
	{ code: "PHP", digits: 2, symbol: "₱", name: "Philippine Peso" },
	{ code: "PKR", digits: 2, symbol: "Rs", name: "Pakistani Rupee" },
	{ code: "PLN", digits: 2, symbol: "zł", name: "Polish Zloty" },
	{ code: "QAR", digits: 2, symbol: "QAR", name: "Qatari Riyal" },
	{ code: "RON", digits: 2, symbol: "lei", name: "Romanian Leu" },
	{ code: "SAR", digits: 2, symbol: "SAR", name: "Saudi Riyal" },
	{ code: "SEK", digits: 2, symbol: "kr", name: "Swedish Krona" },
	{ code: "SGD", digits: 2, symbol: "$", name: "Singapore Dollar" },
	{ code: "THB", digits: 2, symbol: "฿", name: "Thai Baht" },
	{ code: "TRY", digits: 2, symbol: "₺", name: "Turkish Lira" },
	{ code: "TWD", digits: 2, symbol: "$", name: "New Taiwan Dollar" },
	{ code: "UAH", digits: 2, symbol: "₴", name: "Ukrainian Hryvnia" },
	{ code: "USD", digits: 2, symbol: "$", name: "US Dollar" },
	{ code: "VND", digits: 0, symbol: "₫", name: "Vietnamese Dong" },
	{ code: "ZAR", digits: 2, symbol: "R", name: "South African Rand" },
] as const satisfies readonly CurrencyInfo[];

/** The code of a currency in {@link SUPPORTED_CURRENCIES}. */
export type SupportedCurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]["code"];

const BY_CODE: ReadonlyMap<string, CurrencyInfo> = new Map(
	SUPPORTED_CURRENCIES.map((row) => [row.code, row]),
);

/** True for an upper-case code listed in {@link SUPPORTED_CURRENCIES}. Exact
 *  match: `"usd"` and `" USD"` are not supported codes (callers normalise). */
export function isSupportedCurrency(code: string): code is SupportedCurrencyCode {
	return BY_CODE.has(code);
}

/** The row for a supported code, or `undefined`. */
export function currencyInfo(code: string): CurrencyInfo | undefined {
	return BY_CODE.get(code);
}

/** The table's minor-unit exponent for a supported code, or `undefined` for any
 *  other code — never a guess. A caller that must still handle an unlisted code
 *  (old data on a read path) decides its own fallback. */
export function currencyDigits(code: string): 0 | 2 | 3 | undefined {
	return BY_CODE.get(code)?.digits;
}
