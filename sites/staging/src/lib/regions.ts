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
import { COUNTRY_CODES, isCodeShapedRegion, normalizeSubdivision } from "@otta-sh/plugin";
import { subdivisionOptions } from "@otta-sh/plugin/subdivisions";
import { byLabel } from "./countries.js";

export interface RegionOption {
	code: string;
	label: string;
}

/** What a view needs to print one region pick list. */
export interface RegionChoice {
	/** The country the list belongs to — echoed as the hidden field above. ""
	 *  when no country is chosen yet. */
	country: string;
	/** Its subdivisions, `{code, label}`, sorted by label. EMPTY ⇒ the view
	 *  shows no region field (no country yet, or one without subdivisions). */
	options: readonly RegionOption[];
	/** The code to preselect: `value` read as one of `country`'s codes (`ca`,
	 *  `US-CA` and `CA` are all `CA`), else "" — a value that is not one of them
	 *  selects nothing rather than inventing an option. */
	selected: string;
}

/** Sorted lists, per country and locale: the names are fixed data, so each
 *  list is decoded and sorted once. Keys are only real countries (a code with
 *  no subdivisions is never stored) times the site's locale(s). */
const sorted = new Map<string, readonly RegionOption[]>();

function optionsFor(country: string, locale: string): readonly RegionOption[] {
	const key = `${country}\u0000${locale}`;
	const cached = sorted.get(key);
	if (cached !== undefined) return cached;
	const subdivisions = subdivisionOptions(country);
	if (subdivisions.length === 0) return [];
	const options = Object.freeze(
		subdivisions
			.map((option) => Object.freeze({ code: option.code, label: option.name }))
			.toSorted(byLabel(locale)),
	);
	sorted.set(key, options);
	return options;
}

/** The pick list for `country`, with `value` (a stored or typed region) preselected. */
export function regionChoice(country: string, value: string, locale: string): RegionChoice {
	const code = country.trim().toUpperCase();
	const options = optionsFor(code, locale);
	if (options.length === 0) return { country: code, options: [], selected: "" };
	const read = normalizeSubdivision(code, value);
	return { country: code, options, selected: read.ok && read.code !== null ? read.code : "" };
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
	return !normalizeSubdivision(code, value).ok;
}
