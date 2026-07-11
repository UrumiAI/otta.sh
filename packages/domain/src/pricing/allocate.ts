import { type Cents, cents } from "../money/cents.js";

/**
 * Largest-remainder apportionment (Phase 6 §4): split an integer `total` across
 * buckets proportional to `weights`, guaranteeing `Σ result === total` EXACTLY
 * for any non-negative integer `total` and non-negative integer `weights`.
 *
 * This is the mechanism that makes `computeTotals`'s sum-of-parts identity hold
 * **by construction** rather than by rounding luck: give each bucket
 * `floor(total × weight / Σweights)`, then hand the leftover `total − Σfloor`
 * cents out one-by-one to the buckets with the largest fractional remainder
 * (ties broken by input order, for determinism).
 *
 * All products/divisions run in `BigInt`, so `total × weight` — which can exceed
 * `Number.MAX_SAFE_INTEGER` for large carts — never loses precision. The results
 * are each `≤ total`, hence safe integers, and are re-branded `Cents` on the way
 * out.
 *
 * When every weight is `0` (e.g. an all-free cart line-up), the split falls back
 * to an EQUAL apportionment so the invariant still holds for an arbitrary
 * `total` (largest-remainder over uniform weights = round-robin by index).
 */
export function allocateCents(total: Cents, weights: readonly number[]): Cents[] {
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new RangeError(
			`allocateCents requires a non-negative integer total, got ${String(total)}`,
		);
	}
	for (const w of weights) {
		if (!Number.isSafeInteger(w) || w < 0) {
			throw new RangeError(`allocateCents requires non-negative integer weights, got ${String(w)}`);
		}
	}

	const n = weights.length;
	if (n === 0) {
		if (total !== 0) {
			throw new RangeError(`allocateCents cannot distribute ${String(total)} across zero buckets`);
		}
		return [];
	}

	const T = BigInt(total);
	// All-zero weights ⇒ equal split (uniform weight of 1 per bucket).
	const allZero = weights.every((w) => w === 0);
	const eff = allZero ? weights.map(() => 1n) : weights.map((w) => BigInt(w));
	const sumW = eff.reduce((a, b) => a + b, 0n);

	const base: bigint[] = eff.map((w) => (T * w) / sumW);
	// Fractional remainder numerator: (T*w) mod sumW. Larger ⇒ closer to rounding up.
	const frac: bigint[] = eff.map((w, i) => T * w - (base[i] as bigint) * sumW);
	const allocated = base.reduce((a, b) => a + b, 0n);
	const leftover = Number(T - allocated); // integer in [0, n)

	// Rank buckets by fractional remainder desc, ties broken by index asc.
	const order = Array.from({ length: n }, (_v, i) => i).toSorted((a, b) => {
		const fa = frac[a] as bigint;
		const fb = frac[b] as bigint;
		if (fa === fb) return a - b;
		return fb > fa ? 1 : -1;
	});

	const out = base.map((b) => Number(b));
	for (let k = 0; k < leftover; k++) {
		const idx = order[k] as number;
		out[idx] = (out[idx] as number) + 1;
	}
	return out.map((c) => cents(c));
}
