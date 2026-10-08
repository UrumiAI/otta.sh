/**
 * Money display formatting (Phase 2 §4.6) — the admin console's ONE sanctioned
 * money→display boundary, on BOTH surfaces, and the only place a money value
 * may touch a plain-string surface. It takes BRANDED types only (`./money.js`,
 * the documented mirror of the domain's brands): a raw `number` amount
 * or raw `string` currency is a compile error (pinned by
 * `packages/plugin/test/format-money.type-test.ts`, mirroring Phase 0's `Cents`
 * test).
 *
 * Lived in `@otta-sh/plugin` until INC-20, under a standing note to "extract to
 * a shared presentation package only when a second real consumer package exists
 * (ADR-0002 rule 5)". `@otta-sh/admin-react` is that second consumer: it renders
 * the same orders and may not import the plugin (ADR-0014 Decision 3), so G1's
 * "always `formatMoney(Cents, Currency, locale)`" is satisfiable only by both
 * surfaces calling THIS function. The plugin's `presentation/format-money.ts` is
 * now a re-export of it, which is what keeps the plugin's own money suites
 * covering this code. Formatting is explicitly NOT a domain concern; this sits
 * downstream of the branded types the domain defines.
 *
 * No float ever touches the amount: the minor→major conversion is integer
 * string arithmetic, and the exact decimal string is handed to
 * `Intl.NumberFormat.format` (which accepts numeric strings — ES2023 Intl,
 * supported by Node 20+ and workerd's V8). Localization and RTL-safety come
 * from Intl itself, never hand-assembled symbol+number strings.
 */
import { ABSENT } from "./copy.js";
import { minorUnitDigits } from "./currencies.js";
import { cents, currency, type Cents, type Currency } from "./money.js";

export function formatMoney(amount: Cents, currencyCode: Currency, locale: string): string {
	const { format, digits } = currencyFormat(locale, currencyCode);
	return format.format(toMajorUnitsString(amount, digits));
}

/**
 * Locale-independent major-unit decimal string (e.g. `"19.99"`, JPY
 * `"1999"`) — exactly the shape schema.org's `Offer.price` wants (§7 step
 * 8), gated by the same brands.
 */
export function majorUnits(amount: Cents, currencyCode: Currency): string {
	return toMajorUnitsString(amount, minorUnitDigits(currencyCode));
}

/**
 * The formatter and the exponent for `currencyCode`. The exponent is the
 * currency table's ({@link minorUnitDigits}: JPY 0, USD 2, KWD 3), the SAME one
 * the money inputs parse with — so what was typed is what is shown. ICU agrees
 * with the table for almost every listed code, and then the formatter is built
 * exactly as it always was (byte-identical output). Only where ICU's default
 * differs (HUF, IDR, COP, PKR: CLDR 0, ISO 2) are the fraction digits pinned to
 * the table's, so ICU never rounds away a stored minor unit. A code outside the
 * table falls back to ICU's own exponent, i.e. today's behaviour.
 */
function currencyFormat(
	locale: string,
	currencyCode: string,
): { format: Intl.NumberFormat; digits: number } {
	// ONE construction per (locale, code): every money cell on a page formats
	// through here, and an `Intl.NumberFormat` is far costlier to build than to
	// use. A pair that throws is not cached, so it throws again next time.
	const key = `${locale}\u0000${currencyCode}`;
	const cached = FORMATS.get(key);
	if (cached !== undefined) return cached;
	const built = buildCurrencyFormat(locale, currencyCode);
	FORMATS.set(key, built);
	return built;
}

const FORMATS = new Map<string, { format: Intl.NumberFormat; digits: number }>();

function buildCurrencyFormat(
	locale: string,
	currencyCode: string,
): { format: Intl.NumberFormat; digits: number } {
	const digits = minorUnitDigits(currencyCode);
	const plain = new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode });
	if ((plain.resolvedOptions().maximumFractionDigits ?? 2) === digits) {
		return { format: plain, digits };
	}
	return {
		format: new Intl.NumberFormat(locale, {
			style: "currency",
			currency: currencyCode,
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}),
		digits,
	};
}

/** Pure integer string math: `1999, 2 → "19.99"`; `5, 2 → "0.05"`. The
 *  return type is the exact decimal-string shape `Intl.NumberFormat.format`
 *  accepts (a `Cents` is a non-negative safe integer, so the built string is
 *  always a plain `${number}` literal — the assertion never widens truth). */
function toMajorUnitsString(amount: number, digits: number): Intl.StringNumericLiteral {
	if (digits === 0) return String(amount) as Intl.StringNumericLiteral;
	const padded = String(amount).padStart(digits + 1, "0");
	return `${padded.slice(0, -digits)}.${padded.slice(-digits)}` as Intl.StringNumericLiteral;
}

/** What an unformattable or absent amount renders as (M-1). A wrong number is
 *  worse than a missing one, and raw minor units in a money field is the bug
 *  this kills — ABSENT IS NOT ZERO, so this is never `$0.00`. */
export const UNFORMATTABLE = ABSENT;

/** The display locale both admin surfaces render money in. Pinned, like
 *  `DATE_LOCALE`, and for the same reason: it is the single point a
 *  locale-aware console would thread, not a per-call-site choice. */
export const MONEY_LOCALE = "en-US";

/**
 * Format an order-currency amount for display (M-1: money is ALWAYS formatted).
 *
 * THE ONE MONEY→SCREEN CALL BOTH ADMIN SURFACES MAKE. `formatMoney` above is
 * the primitive and takes brands; this is the boundary a screen actually calls,
 * because a screen holds a plain `number` off the wire and a plain currency
 * string, and the branding — with its two failure modes — has to happen
 * somewhere. Doing it here means it happens once.
 *
 * Three deliberate behaviours, all of them previously in `orders-page.ts` and
 * all of them now shared with the React console rather than reimplemented:
 *  - A negative amount formats as its absolute value with an explicit minus
 *    prefix, because `cents()` is branded NON-NEGATIVE and throws below zero.
 *  - An amount `Intl` cannot format renders {@link UNFORMATTABLE}, never
 *    `${CUR} ${minorUnits}`. The old fallback printed RAW MINOR UNITS in the one
 *    place it was least visible — a wrong number dressed as a formatted total.
 *
 * IT DOES NOT ACCEPT `null | undefined`, and that is a deliberate narrowing
 * (INC-20 review). The first cut took nullable money and dashed it, which reads
 * like defensive generosity and is the opposite: it moves "we have no amount"
 * from a COMPILE error to a dash on a money column, silently, at the one
 * boundary G1 exists to keep honest. No consumer needs it — every call site on
 * both surfaces holds a real `number` and a real currency by the time it gets
 * here, and a nullable one is a bug upstream that should fail `tsc` rather than
 * render. Absence that is genuinely a display state (a refund with no recorded
 * `createdAt`) is the CALLER's `??` and is visible where it happens.
 */
export function formatAmount(minorUnits: number, currencyCode: string): string {
	try {
		const code = currency(currencyCode);
		return minorUnits < 0
			? `−${formatMoney(cents(Math.abs(minorUnits)), code, MONEY_LOCALE)}`
			: formatMoney(cents(minorUnits), code, MONEY_LOCALE);
	} catch {
		return UNFORMATTABLE;
	}
}

/**
 * {@link formatAmount} for a money field that is legitimately UNSET.
 *
 * WHY THIS ONE *DOES* TAKE NULLS, when the note above argues at length that
 * `formatAmount` must not. The distinction is whether absence is a DISPLAY
 * STATE or a bug: an order total is always a number, so a nullable one there is
 * an upstream fault that should fail `tsc`. A product's price, compare-at and
 * unit cost are `null` in the ordinary course — a document synced from the CMS
 * before anyone priced it, a product with no was-price — and that is a fact to
 * render, not a fault to hide. Both halves are checked because a price without
 * a currency is not a price.
 *
 * ABSENT IS NOT ZERO: an unpriced product reads `—`, never `$0.00`. That is the
 * same rule the `On hand` cell keeps for counts and `rowCountLine` keeps for
 * row totals.
 *
 * IT REPLACED A SECOND RENDERER (INC-21). `products-page.ts` carried its own
 * `formatOptionalTotal`, whose Intl-failure branch fell back to
 * `` `${CUR} ${minorUnits}` `` — raw minor units in a money field, which is
 * precisely what G1 exists to forbid and what {@link UNFORMATTABLE}'s own note
 * calls "a wrong number dressed as a formatted total". Sharing this function
 * deletes that branch rather than copying it into the React tier.
 */
export function formatOptionalAmount(
	minorUnits: number | null,
	currencyCode: string | null,
): string {
	if (minorUnits === null || currencyCode === null) return UNFORMATTABLE;
	return formatAmount(minorUnits, currencyCode);
}
