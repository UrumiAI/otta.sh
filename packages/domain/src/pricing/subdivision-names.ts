/**
 * A country's ISO 3166-2 subdivisions with their English names, for a
 * state/province PICK LIST. Display only: what an address stores and what
 * matching reads is the bare code (`CA`), exactly as before — validation stays
 * {@link normalizeSubdivision}'s (region-codes.ts).
 *
 * The names live in their own generated module (`iso-3166-names.generated.ts`,
 * CLDR `common/subdivisions/en.xml`), so code that only validates never loads
 * them. Each call decodes one country's string; the storefront keeps the
 * sorted list it builds from it (its one cache).
 * A subdivision CLDR does not name in English is labelled with its code.
 * Pure: no IO.
 */
import { SUBDIVISION_NAMES } from "./iso-3166-names.generated.js";
import { SUBDIVISIONS } from "./iso-3166.generated.js";
import { normalizeSubdivision } from "./region-codes.js";

export interface SubdivisionOption {
	/** The bare ISO 3166-2 suffix the address stores (`CA`). */
	readonly code: string;
	/** Its English name (`California`), or the code when CLDR names none. */
	readonly name: string;
}

const NONE: readonly SubdivisionOption[] = Object.freeze([]);

/**
 * Every subdivision of `country` (any case, trimmed), sorted by CODE — a
 * caller sorts by name in its own locale. Empty for a country with no
 * subdivisions, and for anything that is not a country code.
 */
export function subdivisionOptions(country: string): readonly SubdivisionOption[] {
	const code = country.trim().toUpperCase();
	const suffixes = SUBDIVISIONS.get(code);
	if (suffixes === undefined) return NONE;
	const names = new Map<string, string>();
	const packed = Object.hasOwn(SUBDIVISION_NAMES, code) ? SUBDIVISION_NAMES[code] : undefined;
	for (const pair of packed?.split("|") ?? []) {
		const space = pair.indexOf(" ");
		names.set(pair.slice(0, space), pair.slice(space + 1));
	}
	return Object.freeze(
		[...suffixes]
			.toSorted()
			.map((suffix) => Object.freeze({ code: suffix, name: names.get(suffix) ?? suffix })),
	);
}

/** The English name of `country`'s subdivision `code` (bare or `CC-` prefixed,
 *  any case), or `null` when it is not one of that country's subdivisions —
 *  read by {@link normalizeSubdivision}, the one rule for what a region code is. */
export function subdivisionName(country: string, code: string): string | null {
	const read = normalizeSubdivision(country, code);
	if (!read.ok || read.code === null) return null;
	const bare = read.code;
	return subdivisionOptions(country).find((option) => option.code === bare)?.name ?? null;
}
