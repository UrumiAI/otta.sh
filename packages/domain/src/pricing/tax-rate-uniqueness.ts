import type { TaxClassId } from "./types.js";

/**
 * One tax rate per (tax class, shipping zone).
 *
 * A rate's identity on the checkout side is its SLOT — `(taxClassId, zoneId)`:
 * the built-in calculator looks a line's rate up by class within the matched zone
 * and nothing else (no priority, no compound flag, no postcode/city — the model
 * has none of those). So two rates in one slot are a DUPLICATE whatever their
 * rate or "applies to shipping" flag, and only one of them can ever be charged.
 *
 * New duplicates are refused at the store (`TaxRulesStore.createRate` throws
 * {@link TaxRateDuplicateError}); a rate's slot is immutable, so an edit can
 * never make one. Duplicates written before that rule are KEPT — never deleted
 * by Otta — and resolved by the one rule below, which the checkout and the
 * admin both read through this module so they cannot disagree:
 *
 *   **The rate with the greatest id applies; the others in its slot are ignored.**
 *
 * "Greatest" is plain code-unit string order (`a < b`), the order the store lists
 * rates in. It is not arbitrary: checkout has always let the last-listed rate of a
 * class overwrite the earlier ones, so this is exactly the rate existing stores
 * were already charging on GOODS — no line-item price changes. An ignored rate is
 * ignored ENTIRELY, its "applies to shipping" flag included, so a merchant reading
 * "only X applies" in the admin is told the truth. That part IS a behaviour change
 * for a store that already holds duplicates where the ignored one was marked
 * "applies to shipping": its shipping tax can disappear (no other applying rate in
 * the zone is flagged) or move to another class's flagged rate (the shipping tax
 * class was the last flagged rate, and that was the ignored one). Deleting the
 * duplicate the merchant doesn't want resolves it either way.
 */

/** The fields that place a rate in its slot — all a rate-like row needs here. */
export interface TaxRateSlotted {
	readonly id: string;
	readonly taxClassId: TaxClassId;
	readonly zoneId: string;
}

/** The rule, as a comparison: true when `a` beats `b` for one slot. */
function outranks(a: TaxRateSlotted, b: TaxRateSlotted): boolean {
	return a.id > b.id;
}

function slotKey(rate: TaxRateSlotted): string {
	// JSON keeps the pair unambiguous whatever characters the ids carry.
	return JSON.stringify([rate.taxClassId, rate.zoneId]);
}

/** The applied rate of each slot present in `rates`, keyed by slot, plus each
 *  rate's key (computed once, in input order). */
function winnersBySlot<R extends TaxRateSlotted>(
	rates: readonly R[],
): { winners: Map<string, R>; keys: string[] } {
	const winners = new Map<string, R>();
	const keys = rates.map((rate) => {
		const key = slotKey(rate);
		const current = winners.get(key);
		if (current === undefined || outranks(rate, current)) winners.set(key, rate);
		return key;
	});
	return { winners, keys };
}

/**
 * The rates that apply: one per slot, the slot's winner. Input order is kept, so
 * any later rule that reads "the last rate listed" sees the same sequence it did
 * before, minus the ignored duplicates. Independent of the input's order for
 * WHICH rate wins.
 */
export function effectiveTaxRates<R extends TaxRateSlotted>(rates: readonly R[]): R[] {
	const { winners, keys } = winnersBySlot(rates);
	return rates.filter((rate, i) => winners.get(keys[i] ?? "") === rate);
}

/** The rate that applies for one `(taxClassId, zoneId)` among `rates`, or null. */
export function appliedTaxRate<R extends TaxRateSlotted>(
	rates: readonly R[],
	taxClassId: TaxClassId,
	zoneId: string,
): R | null {
	let applied: R | null = null;
	for (const rate of rates) {
		if (rate.taxClassId !== taxClassId || rate.zoneId !== zoneId) continue;
		if (applied === null || outranks(rate, applied)) applied = rate;
	}
	return applied;
}

/**
 * Every IGNORED duplicate, mapped to the rate that applies in its slot instead.
 * Empty when `rates` holds no duplicates — the admin's "duplicate: only X applies".
 */
export function shadowedTaxRates<R extends TaxRateSlotted>(
	rates: readonly R[],
): ReadonlyMap<string, R> {
	const { winners, keys } = winnersBySlot(rates);
	const shadowed = new Map<string, R>();
	for (const [i, rate] of rates.entries()) {
		const winner = winners.get(keys[i] ?? "");
		if (winner !== undefined && winner !== rate) shadowed.set(rate.id, winner);
	}
	return shadowed;
}

/**
 * `createRate` was handed a rate for a `(taxClassId, zoneId)` that already has
 * one. Refused rather than adopted or upserted: a create that silently replaced a
 * rate would change the tax a shopper is being quoted, and `updateRate` — with its
 * compare-and-set — is how a rate changes. Carries the existing rate so the admin
 * can name it.
 */
export class TaxRateDuplicateError extends Error {
	override readonly name = "TaxRateDuplicateError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "TAX_RATE_DUPLICATE";
	readonly taxClassId: TaxClassId;
	readonly zoneId: string;
	readonly existingRateId: string;
	readonly existingRateBps: number;

	constructor(existing: { id: string; taxClassId: TaxClassId; zoneId: string; rateBps: number }) {
		super(
			`tax class ${existing.taxClassId} already has a rate for zone ${existing.zoneId} ` +
				`(${existing.id}) — one rate per class and zone; edit it with updateRate`,
		);
		this.taxClassId = existing.taxClassId;
		this.zoneId = existing.zoneId;
		this.existingRateId = existing.id;
		this.existingRateBps = existing.rateBps;
	}
}

/**
 * Structural test for {@link TaxRateDuplicateError} — the code AND the fields a
 * caller reads off it, so an object that only claims the code (across a bridge,
 * or forged) is never trusted to name a rate.
 */
export function isTaxRateDuplicateError(err: unknown): err is TaxRateDuplicateError {
	if (!hasTaxRateDuplicateCode(err)) return false;
	const e = err as { existingRateId?: unknown; existingRateBps?: unknown };
	return typeof e.existingRateId === "string" && typeof e.existingRateBps === "number";
}

function hasTaxRateDuplicateCode(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "TAX_RATE_DUPLICATE"
	);
}
