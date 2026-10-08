/**
 * The admin surfaces' COPY of `@otta-sh/domain`'s currency table
 * (`packages/domain/src/money/currencies.ts`) — the canonical file, whose header
 * says how to add a currency. Same rows, same helpers, NOT an import of it, for
 * the reason `./money.ts`'s header gives: this package imports nothing
 * (`admin-presentation-is-dependency-free`), and the React console may import
 * no workspace package but this one.
 *
 * ONE SOURCE OF TRUTH IN EFFECT: `packages/plugin/test/money-parity.test.ts`
 * imports both tables and fails unless they are deep-equal, so a row added to
 * one and not the other is a red test, never a silent drift.
 *
 * Adds {@link minorUnitDigits}, the display/input exponent every admin money
 * boundary reads: the table's digits for a listed code, else the runtime's
 * own (ICU) exponent so a row stored in an unlisted code still renders as it
 * always did.
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
 * The minor-unit exponent money is DISPLAYED in (`formatMoney`, `majorUnits`):
 * the table's for a listed code; for any other code (old data) the runtime's
 * ICU exponent it always rendered with, and 2 when ICU cannot say. Never throws.
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

/** ICU's exponent per unlisted code, probed once (an `Intl.NumberFormat` is
 *  costly to build, and the answer never changes within a process). */
const ICU_DIGITS = new Map<string, number>();

/**
 * The minor-unit exponent money is TYPED in (the admin's money inputs and their
 * copy): the table's for a listed code, and hundredths for ANY other code —
 * exactly the rule every input had before the table existed, so an amount in
 * an unlisted code (ALL, ISK, …) is typed, stored and sent to Stripe as it
 * always was. Deliberately NOT the display fallback: ICU's exponent for an
 * unlisted code is not what its stored integers mean.
 */
export function inputMinorUnitDigits(code: string): number {
	return currencyDigits(code) ?? 2;
}

/**
 * The warning an admin screen shows beside a currency the store can price in
 * but the Stripe live path cannot CHARGE yet — the three-decimal currencies
 * (KWD, BHD, OMR, JOD): Stripe wants their amounts in multiples of 10 fils,
 * and an order total need not be one. `null` for every other code. Mirrors
 * `@otta-sh/payments-stripe`'s `stripeRefusesCurrency` for listed codes
 * (pinned by `packages/plugin/test/money-parity.test.ts`); no behaviour hangs on
 * it — it only tells the merchant before a buyer finds out at checkout.
 */
export function stripePaymentWarning(code: string): string | null {
	return currencyDigits(code) === 3
		? `${code} prices are not yet payable via Stripe — checkout will refuse a card payment in ${code}.`
		: null;
}

/** The short form for a picker option or field label: `(not yet payable via Stripe)`. */
export const NOT_YET_PAYABLE_VIA_STRIPE = "not yet payable via Stripe";
