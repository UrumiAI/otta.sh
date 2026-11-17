/**
 * The admin SHIPPING operations: the decision half of the zone and rate writes,
 * with no form parsing and no notice.
 *
 * WHY THEY ARE HERE. These rules used to live inline in the Shipping console
 * (`shipping-page.ts`), one layer above `AdminRulesSurface`: a zone's regions
 * must be ISO codes and no code may sit in two zones (ADR-0021), the FIRST zone
 * needs an acknowledgement (it turns on address matching), and a free-shipping
 * threshold on a flat-rate method is refused (the domain would never apply it).
 * A second caller (the MCP tools) calling the surface directly would have to
 * restate all of them. So each write is one function here, and both callers go
 * through it: the page parses its form, calls the operation, and turns the
 * outcome into a notice; an MCP route validates its input, calls the operation,
 * and turns the outcome into JSON. Moved verbatim — no rule changed on the way.
 *
 * WHAT STAYS ON THE PAGE. Form parsing (ids, money, currency codes), the
 * "blank name" refusal, and every word of notice copy — `regionHint` included:
 * an `invalid_codes` refusal carries the bad tokens as typed, and the page
 * renders each with its hint. An outcome carries the typed REASON, never copy.
 *
 * Results the surface already types (`RulesCreateResult`, `RulesUpdateResult`,
 * `RulesCasUpdateResult`) pass through under `{ ok: true, result }`: the guard
 * let the write through, and the surface's own answer is the outcome.
 *
 * TWO NEW PIECES, used only by MCP: {@link updateZone} accepts a PARTIAL edit
 * (the surface's is a full replace), and {@link upsertRate} creates a rate or
 * updates the one that exists. The page's create and save are unchanged.
 */
import { parseZoneRegions, validateZoneRegionsInput } from "@urumi.ai/otta-domain";
import type {
	AdminRulesSurface,
	RulesCasUpdateResult,
	RulesCreateResult,
	RulesUpdateResult,
	ShippingRateEdit,
	ShippingRateInput,
	ShippingRateWire,
	ShippingZoneWire,
} from "../admin-rules-surface.js";

/** The regions input checked: the codes to store, or why not. */
export type ZoneRegionsCheck =
	/** The ISO codes to store; `null` for a blank input (a zone that matches no address). */
	| { ok: true; codes: string[] | null }
	/** Tokens that are not a country or a real `CC-SUB` code, as typed. */
	| { ok: false; reason: "invalid_codes"; invalid: string[] }
	/** `code` is already listed by another zone. */
	| { ok: false; reason: "overlap"; code: string; zoneId: string; zoneName: string };

/** A zone write refused by its regions; nothing was written. */
export type ZoneRegionsRefusal = Extract<ZoneRegionsCheck, { ok: false }>;

/** A zone create refused before any write. `first_zone_unacknowledged`: the
 *  store has no zone yet, and creating the first one means every address
 *  outside the zones can no longer check out — the caller must say so. */
export type ZoneCreateRefusal =
	| ZoneRegionsRefusal
	| { ok: false; reason: "first_zone_unacknowledged" };

/** A rate write refused before any write: a free-shipping threshold on a
 *  flat-rate method, which always charges its rate. */
export type RateThresholdRefusal = { ok: false; reason: "threshold_on_flat_rate" };

/**
 * The regions input → the ISO codes to store (ADR-0021), or a typed refusal.
 * Two checks, both before any write:
 *  - every token is a country or a real `CC-SUB` code (the domain's
 *    `validateZoneRegionsInput`) — each bad token is returned;
 *  - no code is already listed by ANOTHER zone (`selfId` is the zone being
 *    edited, `null` on create): an overlap would make an address match two
 *    zones (checkout would take the lowest id and log it).
 * Blank ⇒ `null` (no regions — a zone that matches no address).
 */
export async function checkZoneRegions(
	client: AdminRulesSurface,
	raw: string,
	selfId: string | null,
): Promise<ZoneRegionsCheck> {
	const validated = validateZoneRegionsInput(raw);
	if (!validated.ok) return { ok: false, reason: "invalid_codes", invalid: validated.invalid };
	if (validated.codes === null) return { ok: true, codes: null };
	const zones = await client.listZones();
	for (const other of zones) {
		if (other.id === selfId) continue;
		const theirs = parseZoneRegions(other.regions).codes;
		const shared = validated.codes.find((code) => theirs.includes(code));
		if (shared !== undefined) {
			return { ok: false, reason: "overlap", code: shared, zoneId: other.id, zoneName: other.name };
		}
	}
	return { ok: true, codes: validated.codes };
}

export interface ZoneCreateInput {
	id: string;
	name: string;
	/** The comma-separated regions input, as the page takes it. */
	regions: string;
	/** The caller acknowledges that the FIRST zone turns on address matching.
	 *  Absent ⇒ not acknowledged: creating the first zone is refused. */
	acknowledgeFirstZone?: boolean;
}

/**
 * Create a zone: the regions check, then — when the caller has not acknowledged
 * it — a FRESH read for "is this the first zone" (never a screen's stale list),
 * then the write. The regions refusal is reported before the acknowledgement's.
 */
export async function createZone(
	client: AdminRulesSurface,
	input: ZoneCreateInput,
): Promise<ZoneCreateRefusal | { ok: true; result: RulesCreateResult<ShippingZoneWire> }> {
	const checked = await checkZoneRegions(client, input.regions, null);
	if (!checked.ok) return checked;
	if (input.acknowledgeFirstZone !== true && (await client.listZones()).length === 0) {
		return { ok: false, reason: "first_zone_unacknowledged" };
	}
	const result = await client.createZone({
		id: input.id,
		name: input.name,
		regions: checked.codes,
	});
	return { ok: true, result };
}

/**
 * Edit a zone (LWW). The surface's edit is a FULL replace; this one takes
 * either field alone — an omitted field keeps its stored value (read from the
 * zone list), so an agent renaming a zone cannot wipe its regions. Given
 * regions are checked as on create (blank clears them); stored regions are sent
 * back untouched. With both fields given — what the page sends — no extra read
 * is made. A zone that does not exist is the surface's `not_found`.
 */
export async function updateZone(
	client: AdminRulesSurface,
	zoneId: string,
	edit: { name?: string; regions?: string },
): Promise<ZoneRegionsRefusal | { ok: true; result: RulesUpdateResult<ShippingZoneWire> }> {
	let regions: unknown;
	if (edit.regions !== undefined) {
		const checked = await checkZoneRegions(client, edit.regions, zoneId);
		if (!checked.ok) return checked;
		regions = checked.codes;
	}
	let name = edit.name;
	if (name === undefined || edit.regions === undefined) {
		const stored = (await client.listZones()).find((zone) => zone.id === zoneId);
		if (stored === undefined) return { ok: true, result: { ok: false, reason: "not_found" } };
		name ??= stored.name;
		if (edit.regions === undefined) regions = stored.regions;
	}
	return { ok: true, result: await client.updateZone(zoneId, { name, regions }) };
}

/** Whether `methodId` (in `zoneId`) is a flat-rate method. */
async function isFlatRateMethod(
	client: AdminRulesSurface,
	zoneId: string,
	methodId: string,
): Promise<boolean> {
	const methods = await client.listMethods(zoneId);
	return methods.find((m) => m.id === methodId)?.type === "flat_rate";
}

/** The threshold guard: only read when a threshold was actually given, so the
 *  common blank case costs no read. */
async function refusesThreshold(
	client: AdminRulesSurface,
	zoneId: string,
	methodId: string,
	minSubtotalCents: number | null | undefined,
): Promise<boolean> {
	return (
		minSubtotalCents !== null &&
		minSubtotalCents !== undefined &&
		(await isFlatRateMethod(client, zoneId, methodId))
	);
}

/** Create a method's rate in one currency, behind the flat-rate threshold guard. */
export async function createRate(
	client: AdminRulesSurface,
	zoneId: string,
	methodId: string,
	input: ShippingRateInput,
): Promise<RateThresholdRefusal | { ok: true; result: RulesCreateResult<ShippingRateWire> }> {
	if (await refusesThreshold(client, zoneId, methodId, input.minSubtotalCents)) {
		return { ok: false, reason: "threshold_on_flat_rate" };
	}
	return { ok: true, result: await client.createRate(methodId, input) };
}

/** Edit a method's rate (CAS on `edit.expectedAmountCents`), behind the same guard. */
export async function updateRate(
	client: AdminRulesSurface,
	zoneId: string,
	methodId: string,
	currency: string,
	edit: ShippingRateEdit,
): Promise<RateThresholdRefusal | { ok: true; result: RulesCasUpdateResult<ShippingRateWire> }> {
	if (await refusesThreshold(client, zoneId, methodId, edit.minSubtotalCents)) {
		return { ok: false, reason: "threshold_on_flat_rate" };
	}
	return { ok: true, result: await client.updateRate(methodId, currency, edit) };
}

/**
 * Set a method's rate in one currency: create it when there is none, otherwise
 * update it. The update is a CAS against `input.expectedAmountCents` when the
 * caller read one, else against the amount read here — so an edit landing in
 * between comes back `stale`, never clobbered. An omitted `minSubtotalCents`
 * keeps the stored threshold; `null` clears it. Only MCP calls this.
 */
export async function upsertRate(
	client: AdminRulesSurface,
	zoneId: string,
	methodId: string,
	input: ShippingRateInput & { expectedAmountCents?: number },
): Promise<
	| RateThresholdRefusal
	| {
			ok: true;
			result: RulesCreateResult<ShippingRateWire> | RulesCasUpdateResult<ShippingRateWire>;
	  }
> {
	const current = await client.getRate(methodId, input.currency);
	if (current === null) {
		return createRate(client, zoneId, methodId, {
			currency: input.currency,
			amountCents: input.amountCents,
			minSubtotalCents: input.minSubtotalCents ?? null,
		});
	}
	return updateRate(client, zoneId, methodId, input.currency, {
		amountCents: input.amountCents,
		minSubtotalCents:
			input.minSubtotalCents === undefined ? current.minSubtotalCents : input.minSubtotalCents,
		expectedAmountCents: input.expectedAmountCents ?? current.amountCents,
	});
}
