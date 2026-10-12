import { type Cents, cents } from "../money/cents.js";
import { mulDivRoundHalfUp } from "./round.js";

/**
 * Per-line tax (Phase 6 §4): `round_half_up(amount × rateBps / 10_000)`, in pure
 * integer minor units. Granularity is per-line (each line and the shipping line
 * rounded independently, then summed) so every line is individually auditable on
 * an invoice.
 *
 * `computeLineTax(0, r) === 0` and `computeLineTax(a, 0) === 0` for all inputs.
 * The `amount × rateBps` multiply runs in `BigInt` (via `mulDivRoundHalfUp`,
 * review I5) so no intermediate can overflow the safe-integer range and no float
 * ever appears — uniform with `allocateCents`.
 */
export function computeLineTax(amountCents: Cents, rateBps: number): Cents {
	if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
		throw new RangeError(
			`computeLineTax requires a non-negative integer rateBps, got ${String(rateBps)}`,
		);
	}
	return cents(mulDivRoundHalfUp(amountCents, rateBps, 10_000));
}

/** Millionths in 100% — the denominator of a rate in `ratePpm` (#425). */
export const PPM_DENOMINATOR = 1_000_000;

/**
 * {@link computeLineTax} at a rate in MILLIONTHS (0.0001%, #425):
 * `round_half_up(amount × ratePpm / 1_000_000)`. For a whole-bps rate
 * (`ratePpm = rateBps × 100`) it is the same rational, rounded the same way, so
 * it answers exactly what `computeLineTax` answers.
 */
export function computeLineTaxPpm(amountCents: Cents, ratePpm: number): Cents {
	if (!Number.isSafeInteger(ratePpm) || ratePpm < 0) {
		throw new RangeError(
			`computeLineTaxPpm requires a non-negative integer ratePpm, got ${String(ratePpm)}`,
		);
	}
	return cents(mulDivRoundHalfUp(amountCents, ratePpm, PPM_DENOMINATOR));
}
