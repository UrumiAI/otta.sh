import { type Cents, cents } from "../money/cents.js";
import { divRoundHalfUp } from "./round.js";

/**
 * Per-line tax (Phase 6 §4): `round_half_up(amount × rateBps / 10_000)`, in pure
 * integer minor units. Granularity is per-line (each line and the shipping line
 * rounded independently, then summed) so every line is individually auditable on
 * an invoice.
 *
 * `computeLineTax(0, r) === 0` and `computeLineTax(a, 0) === 0` for all inputs.
 * `amount × rateBps` stays within the safe-integer range for realistic carts
 * (≤ ~4e9 cents × 10_000 bps = 4e13 ≪ 2^53); `divRoundHalfUp` additionally does
 * the multiply-free division in BigInt, so there is no float anywhere.
 */
export function computeLineTax(amountCents: Cents, rateBps: number): Cents {
	if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
		throw new RangeError(
			`computeLineTax requires a non-negative integer rateBps, got ${String(rateBps)}`,
		);
	}
	return cents(divRoundHalfUp(amountCents * rateBps, 10_000));
}
