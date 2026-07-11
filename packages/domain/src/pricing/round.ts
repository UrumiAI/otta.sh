/**
 * Integer rounding for money math (Phase 6 §4). Money never touches a float:
 * every rate is integer basis points and every division is reconciled by an
 * explicit, named rounding function so the strategy is a one-place change
 * (§8 risk #4).
 *
 * **Half-up** (round-half-away-from-zero), the classic customer-facing rounding
 * tax authorities and merchants expect on a receipt — NOT banker's rounding.
 * Amounts here are always non-negative (money is never negative pre-rounding),
 * so half-away-from-zero and half-up coincide.
 */

/**
 * `floor((numerator + denominator/2) / denominator)` for non-negative integer
 * inputs — half-up rounding of `numerator / denominator`. `denominator` must be
 * a positive even integer (all call sites divide by `10_000` basis points), so
 * `denominator / 2` is exact. Uses `BigInt` internally so no intermediate ever
 * leaves the safe-integer range and no float drift is possible; the quotient is
 * bounded by the inputs and returned as a plain safe integer.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
	if (!Number.isSafeInteger(numerator) || numerator < 0) {
		throw new RangeError(
			`divRoundHalfUp requires a non-negative integer numerator, got ${String(numerator)}`,
		);
	}
	if (!Number.isSafeInteger(denominator) || denominator <= 0 || denominator % 2 !== 0) {
		throw new RangeError(
			`divRoundHalfUp requires a positive even integer denominator, got ${String(denominator)}`,
		);
	}
	const n = BigInt(numerator);
	const d = BigInt(denominator);
	const q = (n + d / 2n) / d;
	return Number(q);
}

/**
 * Half-up of `(a × b) / denominator`, with the multiply done in `BigInt` so no
 * intermediate ever leaves the safe-integer range (review I5 — uniform with
 * `allocateCents`). `a`, `b` non-negative safe integers; `denominator` a positive
 * even integer. The quotient is bounded by the inputs and returned as a plain
 * safe integer.
 */
export function mulDivRoundHalfUp(a: number, b: number, denominator: number): number {
	if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0) {
		throw new RangeError(
			`mulDivRoundHalfUp requires non-negative integer factors, got ${String(a)}, ${String(b)}`,
		);
	}
	if (!Number.isSafeInteger(denominator) || denominator <= 0 || denominator % 2 !== 0) {
		throw new RangeError(
			`mulDivRoundHalfUp requires a positive even integer denominator, got ${String(denominator)}`,
		);
	}
	const d = BigInt(denominator);
	return Number((BigInt(a) * BigInt(b) + d / 2n) / d);
}
