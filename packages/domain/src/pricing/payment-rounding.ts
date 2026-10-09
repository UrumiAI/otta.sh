import { currencyPaymentIncrement } from "../money/currencies.js";
import { roundHalfUpToMultiple } from "./round.js";

/**
 * The checkout's payment rounding (ADR-0033 amendment), in ONE place.
 *
 * THE PRESENCE RULE, everywhere a rounding travels: it EXISTS for a quote or
 * order in a currency with a payment increment (KWD, BHD, OMR, JOD) — 0 included,
 * meaning "this total was rounded and nothing moved" — and is ABSENT for every
 * other currency, so their breakdowns, stored totals and wires are exactly what
 * they always were. Only what a person READS drops a 0: the "Rounding" row of a
 * page, an email and the admin's order detail appears when it is non-zero.
 */

/**
 * The total a payment can be for `exactTotal` (the exact sum of the parts):
 * unchanged for a currency without a payment increment, else rounded half-up to
 * it (KWD 1.234 → 1.230, 1.235 → 1.240). UNCHECKED — `assembleTotals` brands it,
 * and the quote's overflow fence tests it.
 */
export function payableTotal(exactTotal: number, currencyCode: string): number {
	const increment = currencyPaymentIncrement(currencyCode);
	return increment === undefined ? exactTotal : roundHalfUpToMultiple(exactTotal, increment);
}

/**
 * `{ [key]: rounding }` when there is one, `{}` when there is none — the one
 * conditional spread every carrier of a rounding uses (breakdown → order totals →
 * stores → wires), so the presence rule above cannot drift between them.
 */
export function roundingEntry<K extends string, V extends number>(
	key: K,
	rounding: V | undefined,
): { [P in K]?: V } {
	return (rounding === undefined ? {} : { [key]: rounding }) as { [P in K]?: V };
}
