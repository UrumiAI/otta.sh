/**
 * The shipping/tax zone, derived from the ship-to address (ADR-0021).
 *
 * Nobody supplies a zone: it is the one whose ISO codes match the address.
 * MOST SPECIFIC first: the address's own `CC-SUB`, then each subdivision
 * containing it (CLDR containment, nearest first), then `CC`. So `ES-TF`
 * (Santa Cruz de Tenerife) tries `ES-TF` → `ES-CN` (Canary Islands) → `ES`,
 * and `GB-BFS` → `GB-NIR` → `GB`: a zone on the child beats one on its
 * parent, which beats one on the country. Codes themselves are exact (case
 * aside) — a zone never covers a code it does not list or contain. Pure: no IO.
 */
import type { ShippingZone } from "../ports/shipping-rules-store.js";
import { parseZoneRegions, subdivisionAncestors } from "./region-codes.js";

/** An address already normalised: a valid country, a real bare subdivision
 *  code or `null` (see `normalizeSubdivision`). */
export interface ZoneDestination {
	country: string;
	region: string | null;
}

export type ZoneResolution =
	/** No physical line: nothing ships, so no zone applies. */
	| { status: "not_required" }
	/** No zones are configured: no shipping and no tax (pre-ADR-0021 behaviour). */
	| { status: "no_zones" }
	/** Zones exist but no address was given yet. */
	| { status: "address_needed" }
	/** Zones exist and the address matches none of them. */
	| { status: "unmatched" }
	/** A zone lists a subdivision of this country, and the address has no region. */
	| { status: "region_code_required"; country: string }
	| {
			status: "matched";
			zoneId: string;
			/** The code that matched: `US-CA`, an ancestor (`ES-CN` for `ES-TF`), or `US`. */
			matchedRegion: string;
			/** Other zones that matched at the same specificity (a misconfiguration
			 *  the admin refuses); empty in a healthy store. */
			ambiguousWith: string[];
	  };

export function resolveShippingZone(
	zones: ReadonlyArray<ShippingZone>,
	input: { requiresShipping: boolean; destination?: ZoneDestination },
): ZoneResolution {
	if (!input.requiresShipping) return { status: "not_required" };
	if (zones.length === 0) return { status: "no_zones" };
	const destination = input.destination;
	if (destination === undefined) return { status: "address_needed" };

	const country = destination.country;
	const parsed = zones.map((z) => ({ id: z.id, codes: parseZoneRegions(z.regions).codes }));

	if (destination.region === null) {
		const prefix = `${country}-`;
		if (parsed.some((z) => z.codes.some((code) => code.startsWith(prefix)))) {
			return { status: "region_code_required", country };
		}
	}

	const own = destination.region === null ? null : `${country}-${destination.region}`;
	const candidates = own === null ? [country] : [own, ...subdivisionAncestors(own), country];
	for (const code of candidates) {
		const ids = parsed
			.filter((z) => z.codes.includes(code))
			.map((z) => z.id)
			.toSorted();
		const [winner, ...rest] = ids;
		if (winner !== undefined) {
			return { status: "matched", zoneId: winner, matchedRegion: code, ambiguousWith: rest };
		}
	}
	return { status: "unmatched" };
}
