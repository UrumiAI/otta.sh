/**
 * Shared money TEXT-input parsing/formatting for admin screens (NO float
 * arithmetic — CLAUDE.md). The ONE implementation behind the Products
 * console's price/compare-at/cost fields and the Shipping console's rate
 * amount/threshold fields (extracted from `products-page.ts` when the
 * Shipping console needed a second, near-identical copy).
 *
 * Parse a merchant-entered decimal amount into integer MINOR UNITS with
 * EXACT integer string math — never `parseFloat(...)*100` (which yields
 * 1998.9999… for "19.99"). A Block Kit `number_input` hands back a JS float,
 * so money is a TEXT input parsed here instead. The scale is the CURRENCY's
 * minor-unit exponent from the currency table (`./currencies.ts`): hundredths
 * for USD/EUR, whole units for JPY, thousandths for KWD, and hundredths for any
 * code outside the table — so every caller names the currency the amount is in.
 *
 * The ONE behavioral fork between consumers is whether ZERO is a valid
 * amount, so it is an explicit parameter rather than a second copy:
 *   - product prices: `allowZero: false` — the domain's own `price > 0`
 *     invariant (a free product is not a price of 0, it is "unpriced").
 *   - shipping rates: `allowZero: true` — a $0 flat rate, or a free-shipping
 *     method's below-threshold fallback, are both legitimate (the service's
 *     `shippingRateBody`/`shippingRateUpdateBody` schemas use
 *     `nonnegative()`, not `positive()`).
 */
import { inputMinorUnitDigits } from "./currencies.js";

/**
 * The "currency" of an amount that has none of its own — a percentage coupon
 * written before its cap and minimum spend carried a currency. It is read in
 * hundredths, the pre-table rule, exactly like any code outside the table.
 * Named so a caller says so on purpose rather than by passing a stray null.
 */
export const NO_CURRENCY = "";

/**
 * How many decimals an amount in `currencyCode` may carry, as the clause the
 * admin's refusal copy and field labels use: `"up to two decimal places"` for
 * USD (the exact wording those messages always had), `"whole numbers only"` for
 * JPY, `"up to three decimal places"` for KWD.
 */
export function moneyPrecisionPhrase(currencyCode: string): string {
	const digits = inputMinorUnitDigits(currencyCode);
	if (digits === 0) return "whole numbers only";
	if (digits === 3) return "up to three decimal places";
	return "up to two decimal places";
}

/**
 * An example amount for refusal copy and placeholders, in the currency's own
 * shape, from the two-decimal example the copy always used: `"19.99"` stays
 * `"19.99"` for USD (and any unlisted code), becomes `"1999"` for JPY and
 * `"19.990"` for KWD. THE one example builder, so every screen agrees.
 */
export function moneyInputExample(twoDecimalExample: string, currencyCode: string): string {
	const [major = "0", minor = ""] = twoDecimalExample.split(".");
	const digits = inputMinorUnitDigits(currencyCode);
	if (digits === 0) return `${major}${minor}`;
	return `${major}.${minor.padEnd(digits, "0").slice(0, digits)}`;
}

/** Returns integer minor units, or null for any non-conforming or
 *  out-of-range input (the caller surfaces a per-field message); never
 *  throws.
 *
 *  THE EXPONENT IS THE CURRENCY'S ({@link inputMinorUnitDigits} — the table
 *  `formatMoney` displays with, and hundredths for a code outside it): up to
 *  `digits` fractional digits are accepted and padded, so USD `"24.5"` → 2450,
 *  JPY `"1500"` → 1500 (a fraction is refused — there is no sub-yen unit), KWD
 *  `"1.234"` → 1234. A two-decimal or unlisted currency parses exactly as it did
 *  before the table existed. */
export function parseMinorUnitsInput(
	input: string,
	currencyCode: string,
	opts: { allowZero: boolean },
): number | null {
	const digits = inputMinorUnitDigits(currencyCode);
	const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
	if (m === null) return null;
	const fraction = m[2];
	// "1." / ".5" never match the pattern; a fraction longer than the
	// currency's exponent (or any fraction at all for a zero-decimal one) is a
	// precision the currency does not have — refused, never rounded.
	if (fraction !== undefined && (digits === 0 || fraction.length > digits)) return null;
	const major = Number.parseInt(m[1] ?? "", 10);
	// Pad fractional digits to the exponent: USD ""→"00", "9"→"90"; KWD "5"→"500".
	const minor = digits === 0 ? 0 : Number.parseInt((fraction ?? "").padEnd(digits, "0"), 10);
	if (!Number.isSafeInteger(major)) return null;
	// major×10^digits + minor: all integer operands, exact for safe integers.
	const units = major * 10 ** digits + minor;
	if (!Number.isSafeInteger(units)) return null;
	return units > 0 || (units === 0 && opts.allowZero) ? units : null;
}

/**
 * Format integer minor units back to a decimal string in the currency's own
 * exponent (USD `"4.99"`, JPY `"1500"`, KWD `"1.234"`) for a text input's
 * initial value — pure integer math (no float division on money).
 * WITHOUT a currency symbol — mirrors `formatMoney` being the one
 * symbol-bearing display boundary.
 */
export function formatMinorUnitsInput(minorUnits: number, currencyCode: string): string {
	const digits = inputMinorUnitDigits(currencyCode);
	const sign = minorUnits < 0 ? "-" : "";
	const abs = Math.abs(minorUnits);
	if (digits === 0) return `${sign}${String(abs)}`;
	const scale = 10 ** digits;
	const frac = abs % scale;
	const major = (abs - frac) / scale; // (abs - frac) is a multiple of scale ⇒ exact.
	return `${sign}${String(major)}.${String(frac).padStart(digits, "0")}`;
}

/**
 * The one spelling of an entered amount, FOR COMPARISON ONLY.
 *
 * WHY A FORM NEEDS THIS. A field's committed value is `formatMinorUnitsInput`
 * output (`99.90`), and what the operator typed is whatever they typed (`99.9`,
 * or `99.90 `). Comparing those two as strings calls a form dirty that holds
 * exactly the amount already stored — so a save would leave the group claiming
 * unsaved work, with a re-armed `Save` for a write that changes nothing, beside
 * a receipt saying it succeeded. Two spellings of one amount are one amount:
 * both sides go through the same exact-integer parse and come back in the same
 * spelling.
 *
 * NOT A VALIDATOR, and it decides nothing about what may be written. Anything
 * that does not parse is handed back trimmed, so an unparseable entry still
 * reads as a change from a parseable one and the write's own refusal is what
 * the operator sees. Zero is accepted here for the same reason: whether `0.00`
 * is a legal amount belongs to the write (`allowZero`), not to the question of
 * whether the field moved.
 */
export function canonicalMoneyInput(input: string, currencyCode: string): string {
	const units = parseMinorUnitsInput(input, currencyCode, { allowZero: true });
	return units === null ? input.trim() : formatMinorUnitsInput(units, currencyCode);
}
