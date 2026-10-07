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
export function canonicalMoneyInput(input: string): string {
	const units = parseMinorUnitsInput(input, { allowZero: true });
	return units === null ? input.trim() : formatMinorUnitsInput(units);
}
