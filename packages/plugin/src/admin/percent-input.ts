import { PPM_PER_BPS } from "@urumi-ai/otta-domain";
/**
 * Shared percent ↔ basis-points TEXT-input parsing/formatting for admin
 * screens (NO float arithmetic — CLAUDE.md). The ONE implementation behind
 * the Tax console's rate fields and the Coupons console's percentage-rate
 * field (extracted from `tax-page.ts` when the Coupons console became the
 * second consumer — the same at-second-consumer precedent as
 * `money-input.ts`). Behavior byte-identical to the pre-extraction
 * functions; `tax-rate-percent.test.ts` is the spec.
 */

/**
 * Parse a merchant-entered decimal PERCENT into integer BASIS POINTS (1% =
 * 100 bps) with EXACT integer string math — never `parseFloat(x) * 100`
 * (float drift). A Block Kit `number_input` hands back a JS float, so the
 * rate is a TEXT input parsed here instead. Up to two fractional digits (a
 * hundredth of a percent = 1 bps — the domain's own precision:
 * `rateBps: z.number().int().min(0).max(100_000)`). Returns null for any
 * non-conforming or out-of-range input (the caller surfaces a per-field
 * message); never throws. Exported for its own unit test.
 *   "7.25" → 725, "0" → 0, "100" → 10000, "7.255" (3 decimals) → null.
 */
export function parsePercentToBps(input: string): number | null {
	const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
	if (m === null) return null;
	const major = Number.parseInt(m[1] ?? "", 10);
	// Pad fractional digits to hundredths: ""→"00", "5"→"50", "25"→"25".
	const minor = Number.parseInt((m[2] ?? "").padEnd(2, "0"), 10);
	if (!Number.isSafeInteger(major)) return null;
	// major×100 + minor: all integer operands, exact for safe integers.
	const bps = major * 100 + minor;
	return Number.isSafeInteger(bps) && bps >= 0 && bps <= 100_000 ? bps : null;
}

/**
 * Format integer basis points back to a hundredths-of-a-percent decimal
 * string (WITHOUT a trailing "%" — callers add it, mirroring
 * `formatMinorUnitsInput` not carrying a currency symbol) for a text input's
 * initial value — pure integer math, no float division. Exported for its own
 * unit test.
 */
export function formatBpsAsPercent(bps: number): string {
	const abs = Math.abs(bps);
	const frac = abs % 100;
	const major = (abs - frac) / 100; // (abs - frac) is a multiple of 100 ⇒ exact.
	const fracStr = frac < 10 ? `0${frac}` : String(frac);
	return `${bps < 0 ? "-" : ""}${major}.${fracStr}`;
}

/** Millionths in 1% — a rate in `ratePpm` (#425) is `percent × 10_000`. */
const PPM_PER_PERCENT = 10_000;
/** The parsers' shared bound in basis points: 1000%. */
const MAX_PERCENT_BPS = 100_000;

/**
 * A TAX rate's percent, to WooCommerce's precision (#425): up to FOUR decimal
 * places (0.0001% = one millionth, `WC_Tax::format_tax_rate`), parsed into
 * integer MILLIONTHS with the same exact string math as
 * {@link parsePercentToBps} — never a float. Bounded at 1000% like it; null for
 * anything else, never throws.
 *   "8.875" → 88750, "7.25" → 72500, "0.0001" → 1, "8.87501" → null.
 */
export function parsePercentToPpm(input: string): number | null {
	const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(input.trim());
	if (m === null) return null;
	const major = Number.parseInt(m[1] ?? "", 10);
	const minor = Number.parseInt((m[2] ?? "").padEnd(4, "0"), 10);
	if (!Number.isSafeInteger(major)) return null;
	const ppm = major * PPM_PER_PERCENT + minor;
	return Number.isSafeInteger(ppm) && ppm >= 0 && ppm <= MAX_PERCENT_BPS * PPM_PER_BPS ? ppm : null;
}

/**
 * Integer millionths back to a percent string (no "%"), integer math only. At
 * least two decimals, and the finer digits only when there are any — so a
 * whole-bps rate reads exactly as {@link formatBpsAsPercent} wrote it ("7.25"),
 * and 88750 reads "8.875".
 */
export function formatPpmAsPercent(ppm: number): string {
	const abs = Math.abs(ppm);
	const frac = abs % PPM_PER_PERCENT;
	const major = (abs - frac) / PPM_PER_PERCENT;
	const digits = String(frac)
		.padStart(4, "0")
		.replace(/0{1,2}$/, "");
	return `${ppm < 0 ? "-" : ""}${major}.${digits}`;
}
