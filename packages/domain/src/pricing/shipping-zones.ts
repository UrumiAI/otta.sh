import type { ShippingZone } from "../ports/shipping-rules-store.js";

/**
 * Shipping-zone resolution from the buyer's address (issue #305). Pure: the
 * caller loads the zones, this decides which one an address falls in.
 *
 * ── The `regions` format ──────────────────────────────────────────────────
 * `ShippingZone.regions` is what the admin Shipping page writes: a JSON
 * `string[]` (the comma-separated "Regions" field, trimmed, blanks dropped), or
 * `null` for a zone with no regions. Each entry is one of:
 *
 *   - `CC`      an ISO 3166-1 alpha-2 country code (`US`, `FR`) — every address
 *               in that country;
 *   - `CC-SUB`  an ISO 3166-2 subdivision code (`US-CA`, `GB-ENG`) — addresses
 *               in that country whose region is `SUB` (1–3 letters/digits).
 *
 * Entries are case-insensitive and whitespace around them is ignored. Anything
 * else (a country NAME, a wildcard, a postcode) is malformed: the admin refuses
 * to save it, and a legacy malformed entry already in the store never matches.
 *
 * ── The matching rule ─────────────────────────────────────────────────────
 * The address's country is trimmed and upper-cased; its region likewise, with a
 * leading `CC-` stripped (so `CA` and `US-CA` are the same region of `US`).
 *  1. A zone listing the address's exact subdivision beats a zone listing only
 *     its country (the most specific entry wins).
 *  2. Among zones that match equally specifically, the lowest zone id (by code
 *     unit order) wins — deterministic whatever order the store lists them in.
 *  3. No match ⇒ `NO_ZONE_FOR_ADDRESS`. There is no default zone: shipping to an
 *     address the merchant never listed is refused, never silently priced at 0.
 * The buyer never names a zone; it is always derived here, server-side, and
 * tax is priced in the same derived zone.
 */

/** Where an order ships — only the fields zone matching reads. */
export interface ShippingDestination {
	/** ISO 3166-1 alpha-2 country code, e.g. `US`. */
	country: string;
	/** Region / state / province: `CA` or the full ISO 3166-2 `US-CA`. */
	region?: string | null;
}

/** One parsed `regions` entry. `subdivision: null` ⇒ the whole country. */
export interface ShippingRegion {
	country: string;
	subdivision: string | null;
}

export type ParseShippingRegionsResult =
	| { ok: true; regions: ShippingRegion[] }
	| { ok: false; invalid: string[] };

export type ResolveShippingZoneResult =
	| { ok: true; zone: ShippingZone }
	| { ok: false; reason: "NO_ZONE_FOR_ADDRESS" };

const REGION_TOKEN = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** One entry → a region, or null when malformed. */
export function parseShippingRegion(token: string): ShippingRegion | null {
	const match = REGION_TOKEN.exec(token.trim().toUpperCase());
	if (match === null) return null;
	return { country: match[1] as string, subdivision: match[2] ?? null };
}

/**
 * Validate a zone's stored `regions` value. `null`/`undefined`/`[]` is a zone
 * with no regions (valid; it matches nothing). Every malformed entry is named in
 * `invalid`, in input order, so the admin can say exactly what to fix.
 */
export function parseShippingRegions(value: unknown): ParseShippingRegionsResult {
	if (value === null || value === undefined) return { ok: true, regions: [] };
	if (!Array.isArray(value)) {
		return { ok: false, invalid: [typeof value === "string" ? value : "[object]"] };
	}
	const regions: ShippingRegion[] = [];
	const invalid: string[] = [];
	for (const entry of value as unknown[]) {
		const parsed = typeof entry === "string" ? parseShippingRegion(entry) : null;
		if (parsed === null) invalid.push(String(entry));
		else regions.push(parsed);
	}
	return invalid.length > 0 ? { ok: false, invalid } : { ok: true, regions };
}

/** A zone's well-formed entries only (malformed legacy entries never match). */
function matchableRegions(value: unknown): ShippingRegion[] {
	if (!Array.isArray(value)) return [];
	const out: ShippingRegion[] = [];
	for (const entry of value as unknown[]) {
		if (typeof entry !== "string") continue;
		const parsed = parseShippingRegion(entry);
		if (parsed !== null) out.push(parsed);
	}
	return out;
}

function normalizeRegion(country: string, region: string | null | undefined): string | null {
	if (region === null || region === undefined) return null;
	let r = region.trim().toUpperCase();
	if (r.startsWith(`${country}-`)) r = r.slice(country.length + 1);
	return r.length > 0 ? r : null;
}

/** 2 = subdivision match, 1 = whole-country match, 0 = no match. */
function specificity(regions: ShippingRegion[], country: string, region: string | null): number {
	let best = 0;
	for (const r of regions) {
		if (r.country !== country) continue;
		if (r.subdivision === null) best = Math.max(best, 1);
		else if (region !== null && r.subdivision === region) return 2;
	}
	return best;
}

/** Derive the shipping zone an address falls in — see the module doc's rule. */
export function resolveShippingZone(
	zones: ReadonlyArray<ShippingZone>,
	destination: ShippingDestination,
): ResolveShippingZoneResult {
	const country = destination.country.trim().toUpperCase();
	if (!COUNTRY_CODE.test(country)) return { ok: false, reason: "NO_ZONE_FOR_ADDRESS" };
	const region = normalizeRegion(country, destination.region);

	let best: { zone: ShippingZone; score: number } | null = null;
	for (const zone of zones) {
		const score = specificity(matchableRegions(zone.regions), country, region);
		if (score === 0) continue;
		if (best === null || score > best.score || (score === best.score && zone.id < best.zone.id)) {
			best = { zone, score };
		}
	}
	return best === null
		? { ok: false, reason: "NO_ZONE_FOR_ADDRESS" }
		: { ok: true, zone: best.zone };
}
