/**
 * Money display formatting (Phase 2 §4.6) — the plugin's ONE sanctioned
 * money→display boundary, and the only place a money value may touch a
 * plain-string surface. It takes BRANDED types only (`./money.js`, the
 * plugin's documented mirror of the domain's brands): a raw `number` amount
 * or raw `string` currency is a compile error (pinned by
 * `test/format-money.type-test.ts`, mirroring Phase 0's `Cents` test).
 *
 * Lives in `@urumi/plugin` (pre-approved decision 7): Phase 3's cart
 * consumes THIS function for line totals — extract to a shared presentation
 * package only when a second real consumer package exists (ADR-0002 rule 5).
 * Formatting is explicitly NOT a domain concern; this sits downstream of the
 * branded types the domain defines.
 *
 * No float ever touches the amount: the minor→major conversion is integer
 * string arithmetic, and the exact decimal string is handed to
 * `Intl.NumberFormat.format` (which accepts numeric strings — ES2023 Intl,
 * supported by Node 20+ and workerd's V8). Localization and RTL-safety come
 * from Intl itself, never hand-assembled symbol+number strings.
 */
import type { Cents, Currency } from "./money.js";

export function formatMoney(amount: Cents, currencyCode: Currency, locale: string): string {
	const format = new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode });
	return format.format(toMajorUnitsString(amount, minorUnitDigits(format)));
}

/**
 * Locale-independent major-unit decimal string (e.g. `"19.99"`, JPY
 * `"1999"`) — exactly the shape schema.org's `Offer.price` wants (§7 step
 * 8), gated by the same brands.
 */
export function majorUnits(amount: Cents, currencyCode: Currency): string {
	const format = new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode });
	return toMajorUnitsString(amount, minorUnitDigits(format));
}

/** The currency's minor-unit count, from ICU's own table (JPY 0, USD 2, …). */
function minorUnitDigits(format: Intl.NumberFormat): number {
	return format.resolvedOptions().maximumFractionDigits ?? 2;
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
