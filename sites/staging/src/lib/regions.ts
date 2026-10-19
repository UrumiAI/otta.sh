/**
 * The state/province PICK LIST (ADR-0021): a `<select>` of the chosen
 * country's ISO 3166-2 subdivisions, named in English (CLDR, via the plugin)
 * and sorted for the buyer's locale. The VALUE is the bare code the address
 * has always stored (`CA`), so nothing downstream changes, and the plugin still
 * validates every region it is sent.
 *
 * The list is rendered on the SERVER for the country the page knows, and the
 * page works without JavaScript: changing the country takes a round trip (the
 * form's Update button) that comes back with that country's list and everything
 * typed kept (the draft cookie). The optional script (ADR-0034,
 * `public/scripts/region-picker.js`) swaps the list in place from
 * `/checkout/regions` instead. Either way the server applies ONE rule
 * (`regionOutsideCountry`): a region that is not one of the posted country's is
 * dropped and asked for again.
 */
import { COUNTRY_CODES, isCodeShapedRegion, normalizeSubdivision } from "@urumi.ai/otta-plugin";
import { subdivisionDataVersion, subdivisionOptions } from "@urumi.ai/otta-plugin/subdivisions";
import { byLabel } from "./countries.js";

export interface RegionOption {
	code: string;
	label: string;
	/** The name of the top-level subdivision it sits under (Spain's Tenerife:
	 *  "Canary Islands") — the `<optgroup>` it renders in. Absent for a country
	 *  with one level, and for a top-level subdivision containing nothing. */
	group?: string;
}

/** A run of options in one `<optgroup>` (`label`), or ungrouped (`null`). */
export interface RegionGroup {
	label: string | null;
	options: readonly RegionOption[];
}

/** What a view needs to print one region pick list. */
export interface RegionChoice {
	/** The country the list belongs to — echoed as the hidden field above. ""
	 *  when no country is chosen yet. */
	country: string;
	/** Its subdivisions, `{code, label, group?}`, in display order (see
	 *  {@link groups}). EMPTY ⇒ the view shows no region field (no country yet,
	 *  or one without subdivisions). */
	options: readonly RegionOption[];
	/** The same options as the view prints them. A country with ONE level
	 *  (the US) is a single ungrouped run sorted by label. A country with more
	 *  (GB's nations and council areas, Spain's communities and provinces) puts
	 *  each top-level subdivision that contains others in an `<optgroup>` named
	 *  after it — itself first, then everything inside it — and lists the rest
	 *  ungrouped; groups and the rest are sorted by label. Every level stays
	 *  pickable (zones match through containment, ADR-0021). */
	groups: readonly RegionGroup[];
	/** What `/checkout/regions` serves, as a cache key: the data's fingerprint
	 *  plus this file's list format. The script sends it as `&v=`, so a data
	 *  refresh (or a format change) is never served from a day-old cache. */
	version: string;
	/** The code to preselect: `value` read as one of `country`'s codes (`ca`,
	 *  `US-CA` and `CA` are all `CA`), else "" — a value that is not one of them
	 *  selects nothing rather than inventing an option. */
	selected: string;
}

interface RegionList {
	options: readonly RegionOption[];
	groups: readonly RegionGroup[];
}

const EMPTY: RegionList = Object.freeze({ options: Object.freeze([]), groups: Object.freeze([]) });

/** Sorted lists, per country and locale: the names are fixed data, so each
 *  list is decoded, grouped and sorted once. Keys are only real countries (a
 *  code with no subdivisions is never stored) times the site's locale(s). */
const sorted = new Map<string, RegionList>();

function listFor(country: string, locale: string): RegionList {
	const key = `${country}\u0000${locale}`;
	const cached = sorted.get(key);
	if (cached !== undefined) return cached;
	const subdivisions = subdivisionOptions(country);
	if (subdivisions.length === 0) return EMPTY;
	const parentOf = new Map(subdivisions.map((s) => [s.code, s.parent]));
	/** The top-level subdivision `code` sits under (itself at the top). The
	 *  generator refuses cycles; the bound only makes that local. */
	const rootOf = (code: string): string => {
		let at = code;
		for (let step = 0; step < 8; step += 1) {
			const up = parentOf.get(at);
			if (up === null || up === undefined) break;
			at = up;
		}
		return at;
	};
	const label = new Map(subdivisions.map((s) => [s.code, s.name]));
	const members = new Map<string, RegionOption[]>(); // root → everything under it
	for (const s of subdivisions) {
		const root = rootOf(s.code);
		if (root === s.code) continue;
		const list = members.get(root) ?? [];
		list.push({ code: s.code, label: s.name });
		members.set(root, list);
	}
	const compare = byLabel(locale);
	const groups: RegionGroup[] = [];
	const loose: RegionOption[] = [];
	const flush = (): void => {
		if (loose.length > 0) groups.push({ label: null, options: loose.splice(0) });
	};
	const tops = subdivisions
		.filter((s) => rootOf(s.code) === s.code)
		.map((s) => ({ code: s.code, label: s.name }))
		.toSorted(compare);
	for (const top of tops) {
		const inside = members.get(top.code);
		if (inside === undefined) {
			loose.push(top);
			continue;
		}
		flush();
		const name = label.get(top.code) ?? top.code;
		groups.push({
			label: name,
			options: [top, ...inside.toSorted(compare)].map((o) => ({ ...o, group: name })),
		});
	}
	flush();
	const frozen = groups.map((g) =>
		Object.freeze({
			label: g.label,
			options: Object.freeze(g.options.map((o) => Object.freeze(o))),
		}),
	);
	const list = Object.freeze({
		options: Object.freeze(frozen.flatMap((g) => g.options)),
		groups: Object.freeze(frozen),
	});
	sorted.set(key, list);
	return list;
}

/** Bump when the shape or order of a list changes without the data changing. */
const LIST_FORMAT = "g1";

/** See {@link RegionChoice.version}. */
export function regionListVersion(): string {
	return `${subdivisionDataVersion()}-${LIST_FORMAT}`;
}

/** The pick list for `country`, with `value` (a stored or typed region) preselected. */
export function regionChoice(country: string, value: string, locale: string): RegionChoice {
	const code = country.trim().toUpperCase();
	const { options, groups } = listFor(code, locale);
	const version = regionListVersion();
	if (options.length === 0) return { country: code, options, groups, selected: "", version };
	const read = normalizeSubdivision(code, value);
	return {
		country: code,
		options,
		groups,
		selected: read.ok && read.code !== null ? read.code : "",
		version,
	};
}

/**
 * THE ONE REGION RULE: true when `region` is a code (`ON`, `us-ca`) but not one
 * of `country`'s subdivisions — typically picked from the list of a country the
 * buyer has since changed. Such a region is dropped and asked for again, with
 * the buyer's country kept. Blank, an unknown country, or a value that is not
 * even code-shaped (a theme's typed input, refused by its own path) are not this
 * rule's business.
 */
export function regionOutsideCountry(
	country: string | undefined,
	region: string | undefined,
): boolean {
	const code = (country ?? "").trim().toUpperCase();
	const value = (region ?? "").trim();
	if (value === "" || !COUNTRY_CODES.has(code) || !isCodeShapedRegion(value)) return false;
	if (subdivisionOptions(code).length === 0) return false; // nothing to pick: regionToDropSilently
	return !normalizeSubdivision(code, value).ok;
}

/** Does `country` have subdivisions — a list to pick from? */
export function hasRegionList(country: string | undefined): boolean {
	return subdivisionOptions((country ?? "").trim().toUpperCase()).length > 0;
}

/** A region left over for a country WITHOUT subdivisions (a list it no longer
 *  has): dropped SILENTLY — there is nothing to pick, so nothing to ask. */
export function regionToDropSilently(
	country: string | undefined,
	region: string | undefined,
): boolean {
	const code = (country ?? "").trim().toUpperCase();
	return (
		(region ?? "").trim() !== "" && COUNTRY_CODES.has(code) && subdivisionOptions(code).length === 0
	);
}

/** Is `region` one of `country`'s subdivisions that CONTAINS others (Spain's
 *  Canary Islands)? A store may zone the smaller ones, so the plugin can ask
 *  for one of them (SHIPPING_REGION_CODE_REQUIRED for a region that was given). */
export function regionContainsOthers(country: string, region: string): boolean {
	const code = country.trim().toUpperCase();
	const read = normalizeSubdivision(code, region);
	if (!read.ok || read.code === null) return false;
	const bare = read.code;
	return subdivisionOptions(code).some((option) => option.parent === bare);
}
