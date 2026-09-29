/**
 * ISO 3166 code handling for addresses and shipping zones (ADR-0021).
 *
 * Countries are ISO 3166-1 alpha-2 codes and regions ISO 3166-2 subdivision
 * codes, both checked against the bundled CLDR list (`iso-3166.generated.ts`).
 * Everything here ignores case and surrounding spaces. Pure: no IO.
 *
 * Two layers of strictness, on purpose:
 *  - {@link isCodeShapedRegion} is SHAPE only. It is the one rule the plugin's
 *    route parsers and the site share, so a code-shaped fake ("XX") passes
 *    them and reaches the domain, which answers with a TYPED reason
 *    (`SHIPPING_REGION_CODE_REQUIRED`) the buyer can act on;
 *  - {@link normalizeSubdivision} is MEMBERSHIP: the code must be a real
 *    subdivision of the address's country.
 */
import { COUNTRY_CODES, SUBDIVISIONS } from "./iso-3166.generated.js";

/** A country code, uppercased, or `null` when it is not in `COUNTRY_CODES` (the
 *  officially assigned ISO 3166-1 alpha-2 codes, plus XK). */
export function normalizeCountryCode(raw: string): string | null {
	const code = raw.trim().toUpperCase();
	return COUNTRY_CODES.has(code) ? code : null;
}

/** An optional `CC-` prefix and a 1–3 character alphanumeric suffix. */
const REGION_SHAPE = /^([A-Za-z]{2}-)?[A-Za-z0-9]{1,3}$/;

/** SHAPE only — see the module doc. Trims before testing. */
export function isCodeShapedRegion(raw: string): boolean {
	return REGION_SHAPE.test(raw.trim());
}

export type NormalizeSubdivisionResult = { ok: true; code: string | null } | { ok: false };

/**
 * A region → the canonical BARE subdivision code (`CA`, D13), `null` for
 * blank, or `ok: false` when it is not a real subdivision of `country`.
 * `CA`, `ca`, `US-CA` and `us-ca` are all `CA` for the US; `MX-CA` is refused
 * for the US (the prefix must name the address's own country).
 */
export function normalizeSubdivision(
	country: string,
	raw: string | null | undefined,
): NormalizeSubdivisionResult {
	const trimmed = (raw ?? "").trim();
	if (trimmed.length === 0) return { ok: true, code: null };
	if (!isCodeShapedRegion(trimmed)) return { ok: false };
	const upper = trimmed.toUpperCase();
	const countryCode = country.trim().toUpperCase();
	const dash = upper.indexOf("-");
	const bare = dash === -1 ? upper : upper.slice(dash + 1);
	if (dash !== -1 && upper.slice(0, dash) !== countryCode) return { ok: false };
	return SUBDIVISIONS.get(countryCode)?.has(bare) === true
		? { ok: true, code: bare }
		: { ok: false };
}

/** One zone-region token → its canonical form (`US`, `US-CA`), or `null`. */
function zoneRegionCode(token: string): string | null {
	const upper = token.trim().toUpperCase();
	if (COUNTRY_CODES.has(upper)) return upper;
	const match = /^([A-Z]{2})-([A-Z0-9]{1,3})$/.exec(upper);
	if (match === null) return null;
	const [, country = "", sub = ""] = match;
	return SUBDIVISIONS.get(country)?.has(sub) === true ? `${country}-${sub}` : null;
}

/**
 * A STORED zone's `regions` → the codes it matches on, and the tokens it
 * cannot (legacy free text, or a code no longer in CLDR). Lenient: the port
 * keeps `regions` opaque, and a zone written before ADR-0021 may hold
 * anything. A non-array matches nothing. Invalid tokens never match an
 * address; the admin labels them.
 */
export function parseZoneRegions(regions: unknown): { codes: string[]; invalid: string[] } {
	if (!Array.isArray(regions)) return { codes: [], invalid: [] };
	const codes: string[] = [];
	const invalid: string[] = [];
	for (const entry of regions as unknown[]) {
		const code = typeof entry === "string" ? zoneRegionCode(entry) : null;
		if (code !== null) codes.push(code);
		else invalid.push(typeof entry === "string" ? entry : String(entry));
	}
	return { codes, invalid };
}

export type ValidateZoneRegionsResult =
	| { ok: true; codes: string[] | null }
	| { ok: false; invalid: string[] };

/**
 * The admin's comma-separated regions input → the codes to store. STRICT:
 * every token must be a country code or a real `CC-SUB` subdivision; bad
 * tokens are reported as typed. Duplicates are removed (case-insensitively,
 * first seen wins). Blank ⇒ `null` (no regions).
 */
export function validateZoneRegionsInput(raw: string): ValidateZoneRegionsResult {
	const tokens = raw
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	const codes: string[] = [];
	const invalid: string[] = [];
	for (const token of tokens) {
		const code = zoneRegionCode(token);
		if (code === null) invalid.push(token);
		else if (!codes.includes(code)) codes.push(code);
	}
	if (invalid.length > 0) return { ok: false, invalid };
	return { ok: true, codes: codes.length > 0 ? codes : null };
}
