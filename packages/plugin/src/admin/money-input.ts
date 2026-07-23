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
 * so money is a TEXT input parsed here instead. Hundredths scale (two
 * fractional digits — the near-universal case; zero-decimal currencies like
 * JPY are out of scope, consistent with the codebase's minor-units
 * convention).
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

/** Returns integer minor units, or null for any non-conforming or
 *  out-of-range input (the caller surfaces a per-field message); never
 *  throws. */
export function parseMinorUnitsInput(input: string, opts: { allowZero: boolean }): number | null {
	const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
	if (m === null) return null;
	const major = Number.parseInt(m[1] ?? "", 10);
	// Pad fractional digits to hundredths: ""→"00", "9"→"90", "99"→"99".
	const minor = Number.parseInt((m[2] ?? "").padEnd(2, "0"), 10);
	if (!Number.isSafeInteger(major)) return null;
	// major×100 + minor: all integer operands, exact for safe integers.
	const units = major * 100 + minor;
	if (!Number.isSafeInteger(units)) return null;
	return units > 0 || (units === 0 && opts.allowZero) ? units : null;
}

/**
 * Format integer minor units back to a hundredths decimal string for a text
 * input's initial value — pure integer math (no float division on money).
 * WITHOUT a currency symbol — mirrors `formatMoney` being the one
 * symbol-bearing display boundary.
 */
export function formatMinorUnitsInput(minorUnits: number): string {
	const abs = Math.abs(minorUnits);
	const frac = abs % 100;
	const major = (abs - frac) / 100; // (abs - frac) is a multiple of 100 ⇒ exact.
	const fracStr = frac < 10 ? `0${frac}` : String(frac);
	return `${minorUnits < 0 ? "-" : ""}${major}.${fracStr}`;
}
