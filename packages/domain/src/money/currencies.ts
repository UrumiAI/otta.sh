/**
 * THE CURRENCIES A STORE CAN PRICE IN — the one table every money boundary reads
 * its minor-unit exponent from: the admin's money inputs (`"1500"` JPY is 1500,
 * not 150000), money display, the refund flags, and which currencies the Stripe
 * adapter charges.
 *
 * HOW TO ADD A CURRENCY
 *  1. Add a row below: `code` (ISO 4217 alpha), `digits` (ISO 4217's minor-unit
 *     exponent: 0, 2 or 3 — take it from ISO's own list, not from memory) and an
 *     English `name` (the admin's currency picker shows it). Keep the rows sorted
 *     by code.
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
 * NOT LISTED, ON PURPOSE: ISK (and UGX). ISO gives them 0 digits, but Stripe
 * takes them as two-decimal amounts ending in 00, and every ISK amount written
 * before this table is stored in hundredths. Listing ISK would change the
 * meaning of those stored integers; it needs a data migration first.
 *
 * MEMBERSHIP IS FOR WHAT A MERCHANT TYPES ON THE ADMIN SCREENS. The admin
 * write paths (a product's first price currency, a shipping rate's, a coupon's)
 * refuse a code that is not here; programmatic writes (the product upsert, the
 * variant price edit) check only the shape. READ paths never do: a row stored
 * before this table existed, in any shape-valid code, still loads and renders.
 * A code that is not listed keeps the pre-table rules: money INPUT in
 * hundredths, display in the runtime's own exponent.
 *
 * Pure data — the domain stays IO-free.
 */

/** One row: what a person edits to add a currency. */
export interface CurrencyInfo {
	/** ISO 4217 alphabetic code, upper case. */
	readonly code: string;
	/** ISO 4217 minor-unit exponent: amounts are stored in units of 10^-digits. */
	readonly digits: 0 | 2 | 3;
	/** English display name. */
	readonly name: string;
}

export const SUPPORTED_CURRENCIES = [
	{ code: "AED", digits: 2, name: "United Arab Emirates Dirham" },
	{ code: "ARS", digits: 2, name: "Argentine Peso" },
	{ code: "AUD", digits: 2, name: "Australian Dollar" },
	{ code: "BDT", digits: 2, name: "Bangladeshi Taka" },
	{ code: "BHD", digits: 3, name: "Bahraini Dinar" },
	{ code: "BRL", digits: 2, name: "Brazilian Real" },
	{ code: "CAD", digits: 2, name: "Canadian Dollar" },
	{ code: "CHF", digits: 2, name: "Swiss Franc" },
	{ code: "CLP", digits: 0, name: "Chilean Peso" },
	{ code: "CNY", digits: 2, name: "Chinese Yuan" },
	{ code: "COP", digits: 2, name: "Colombian Peso" },
	{ code: "CZK", digits: 2, name: "Czech Koruna" },
	{ code: "DKK", digits: 2, name: "Danish Krone" },
	{ code: "EGP", digits: 2, name: "Egyptian Pound" },
	{ code: "EUR", digits: 2, name: "Euro" },
	{ code: "GBP", digits: 2, name: "British Pound" },
	{ code: "HKD", digits: 2, name: "Hong Kong Dollar" },
	{ code: "HUF", digits: 2, name: "Hungarian Forint" },
	{ code: "IDR", digits: 2, name: "Indonesian Rupiah" },
	{ code: "ILS", digits: 2, name: "Israeli New Shekel" },
	{ code: "INR", digits: 2, name: "Indian Rupee" },
	{ code: "JOD", digits: 3, name: "Jordanian Dinar" },
	{ code: "JPY", digits: 0, name: "Japanese Yen" },
	{ code: "KES", digits: 2, name: "Kenyan Shilling" },
	{ code: "KRW", digits: 0, name: "South Korean Won" },
	{ code: "KWD", digits: 3, name: "Kuwaiti Dinar" },
	{ code: "MAD", digits: 2, name: "Moroccan Dirham" },
	{ code: "MXN", digits: 2, name: "Mexican Peso" },
	{ code: "MYR", digits: 2, name: "Malaysian Ringgit" },
	{ code: "NGN", digits: 2, name: "Nigerian Naira" },
	{ code: "NOK", digits: 2, name: "Norwegian Krone" },
	{ code: "NZD", digits: 2, name: "New Zealand Dollar" },
	{ code: "OMR", digits: 3, name: "Omani Rial" },
	{ code: "PEN", digits: 2, name: "Peruvian Sol" },
	{ code: "PHP", digits: 2, name: "Philippine Peso" },
	{ code: "PKR", digits: 2, name: "Pakistani Rupee" },
	{ code: "PLN", digits: 2, name: "Polish Zloty" },
	{ code: "QAR", digits: 2, name: "Qatari Riyal" },
	{ code: "RON", digits: 2, name: "Romanian Leu" },
	{ code: "SAR", digits: 2, name: "Saudi Riyal" },
	{ code: "SEK", digits: 2, name: "Swedish Krona" },
	{ code: "SGD", digits: 2, name: "Singapore Dollar" },
	{ code: "THB", digits: 2, name: "Thai Baht" },
	{ code: "TRY", digits: 2, name: "Turkish Lira" },
	{ code: "TWD", digits: 2, name: "New Taiwan Dollar" },
	{ code: "UAH", digits: 2, name: "Ukrainian Hryvnia" },
	{ code: "USD", digits: 2, name: "US Dollar" },
	{ code: "VND", digits: 0, name: "Vietnamese Dong" },
	{ code: "ZAR", digits: 2, name: "South African Rand" },
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

/** The table's minor-unit exponent for a supported code, or `undefined` for any
 *  other code — never a guess. A caller that must still handle an unlisted code
 *  (old data on a read path) decides its own fallback. */
export function currencyDigits(code: string): 0 | 2 | 3 | undefined {
	return BY_CODE.get(code)?.digits;
}

/**
 * Whether checkout can take payment in `code` — false for the table's
 * three-decimal currencies, whose smallest unit the payment path does not charge
 * in (an order total need not be the multiple of 10 it needs). The admin
 * surfaces' `checkoutPaymentWarning` mirrors it (pinned by `money-parity.test.ts`).
 */
export function isCheckoutPayableCurrency(code: string): boolean {
	return currencyDigits(code) !== 3;
}

/**
 * The minor-unit exponent money is DISPLAYED in: the table's for a listed code;
 * for any other code (old data) the runtime's ICU exponent it always rendered
 * with, and 2 when ICU cannot say. Never throws. Mirrored — and pinned equal by
 * `money-parity.test.ts` — by `@otta-sh/admin-presentation`'s `minorUnitDigits`,
 * which `formatMoney` reads, so an operator flag and a screen agree.
 */
export function minorUnitDigits(code: string): number {
	const listed = currencyDigits(code);
	if (listed !== undefined) return listed;
	const known = ICU_DIGITS.get(code);
	if (known !== undefined) return known;
	let digits = 2;
	try {
		digits =
			new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
				.maximumFractionDigits ?? 2;
	} catch {
		digits = 2;
	}
	ICU_DIGITS.set(code, digits);
	return digits;
}

/** ICU's exponent per unlisted code, probed once. */
const ICU_DIGITS = new Map<string, number>();
