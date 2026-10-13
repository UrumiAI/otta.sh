/**
 * A tax rate's value, finer than a basis point (#425, ADR-0036).
 *
 * A rate has always been `rateBps`, integer basis points (0.01%). Some real
 * combined rates need more — New York City's 8.875% — so a rate may also carry
 * `ratePpm`, the rate in integer MILLIONTHS (0.0001%, one hundredth of a basis
 * point: WooCommerce's own four-decimal precision, `WC_Tax::format_tax_rate`).
 *
 * The pair is CANONICAL, so every rate that is a whole basis point keeps exactly
 * the shape it had before:
 *  - a whole basis point is `{ rateBps }` alone — no `ratePpm` key;
 *  - a finer rate is `{ rateBps, ratePpm }`, `rateBps` being `ratePpm` rounded
 *    half up to the nearest basis point (what a reader that only knows basis
 *    points shows — never what is charged).
 *
 * `ratePpm`, when present AND CONSISTENT, is THE rate; {@link ratePpmOf} reads
 * either shape. A rate stored before #425 has no `ratePpm` and reads as
 * `rateBps × 100` — the read-time upgrade; nothing is ever rewritten.
 *
 * `rateBps` is the source of truth whenever the two disagree. A build from before
 * #425 knows only `rateBps`: if it edits a finer rate (8.875% → 9%), it rewrites
 * `rateBps` and carries the old `ratePpm` along untouched, leaving
 * `{ rateBps: 900, ratePpm: 88750 }`. So a `ratePpm` counts only when it is a
 * non-negative safe integer that rounds half up to `rateBps`
 * ({@link finerRatePpm}); otherwise it is ignored and the rate is `rateBps × 100`
 * — what the older build meant. Integer maths only.
 */

/** Millionths in one basis point. */
export const PPM_PER_BPS = 100;

/** A rate's value: whole basis points, plus millionths when finer. */
export interface TaxRateValue {
	/** Integer basis points; when `ratePpm` is present, `ratePpm` rounded half up. */
	rateBps: number;
	/** Integer millionths (0.0001%), present only when not a whole basis point. */
	ratePpm?: number;
}

/**
 * The `ratePpm` a rate really carries: present, a non-negative safe integer, not a
 * whole basis point, and rounding half up to `rateBps`. Anything else — absent,
 * malformed, `null`, or stale (left behind by an edit that only knew `rateBps`) —
 * is `undefined`, and the rate is its `rateBps`.
 */
export function finerRatePpm(rate: { rateBps: unknown; ratePpm?: unknown }): number | undefined {
	const { rateBps, ratePpm } = rate;
	if (typeof ratePpm !== "number" || !Number.isSafeInteger(ratePpm) || ratePpm < 0)
		return undefined;
	if (ratePpm % PPM_PER_BPS === 0 || bpsOfPpm(ratePpm) !== rateBps) return undefined;
	return ratePpm;
}

/** A stored rate's value in canonical form: `{ rateBps }`, plus `ratePpm` only
 *  when {@link finerRatePpm} honours it. What a store returns on every read. */
export function canonicalTaxRateValue(rate: TaxRateValue): TaxRateValue {
	const ppm = finerRatePpm(rate);
	return ppm === undefined ? { rateBps: rate.rateBps } : { rateBps: rate.rateBps, ratePpm: ppm };
}

/** A `rateBps` {@link ratePpmOf} reads: a non-negative safe integer. */
export function isValidRateBps(rateBps: unknown): rateBps is number {
	return typeof rateBps === "number" && Number.isSafeInteger(rateBps) && rateBps >= 0;
}

/**
 * The exact rate in millionths: an honoured `ratePpm` ({@link finerRatePpm}), else
 * `rateBps × 100`. A `rateBps` that is not a non-negative safe integer throws a
 * `RangeError` — corrupt data fails closed, as `computeLineTax` always did.
 */
export function ratePpmOf(rate: TaxRateValue): number {
	if (!isValidRateBps(rate.rateBps)) {
		throw new RangeError(
			`a tax rate needs a non-negative integer rateBps, got ${String(rate.rateBps)}`,
		);
	}
	return finerRatePpm(rate) ?? rate.rateBps * PPM_PER_BPS;
}

/** `ppm` rounded half up to whole basis points (`ppm` a non-negative integer). */
export function bpsOfPpm(ppm: number): number {
	return (ppm - (ppm % PPM_PER_BPS)) / PPM_PER_BPS + (ppm % PPM_PER_BPS >= PPM_PER_BPS / 2 ? 1 : 0);
}

/** The canonical value of a rate of `ppm` millionths. Throws `RangeError` unless
 *  `ppm` is a non-negative safe integer. */
export function taxRateValueOfPpm(ppm: number): TaxRateValue {
	if (!Number.isSafeInteger(ppm) || ppm < 0) {
		throw new RangeError(
			`a tax rate in millionths must be a non-negative integer, got ${String(ppm)}`,
		);
	}
	return ppm % PPM_PER_BPS === 0
		? { rateBps: ppm / PPM_PER_BPS }
		: { rateBps: bpsOfPpm(ppm), ratePpm: ppm };
}

/**
 * What a store writes for an input rate. A `rateBps`-only input is kept as it is
 * (exactly what stores wrote before #425). With `ratePpm`, the value is
 * canonicalized, and a `rateBps` that is not `ratePpm` rounded half up is refused
 * with a `RangeError` — two rates that disagree must never be stored together.
 */
export function normalizeTaxRateValue(input: TaxRateValue): TaxRateValue {
	if (input.ratePpm === undefined) return { rateBps: input.rateBps };
	const value = taxRateValueOfPpm(input.ratePpm);
	if (value.rateBps !== input.rateBps) {
		throw new RangeError(
			`rateBps ${String(input.rateBps)} disagrees with ratePpm ${String(input.ratePpm)} ` +
				`(expected ${String(value.rateBps)})`,
		);
	}
	return value;
}
