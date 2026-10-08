/**
 * The state/province PICK LIST (ADR-0021): a `<select>` of the chosen
 * country's ISO 3166-2 subdivisions, named in English (CLDR, via the plugin)
 * and sorted for the buyer's locale. The VALUE is the bare code the address
 * has always stored (`CA`), so nothing downstream changes, and the plugin still
 * validates every region it is sent.
 *
 * NO CLIENT JS (the review is a plain form): the list is rendered on the
 * SERVER for the country the page knows. Changing the country takes a round
 * trip — the form's Update button — and the page comes back with that
 * country's list and everything typed kept (the draft cookie). The list's own
 * country rides along as a hidden field (`REGION_COUNTRY_FIELD`), so a region
 * picked for one country is never sent as another's: same-looking codes (`01`)
 * exist in many countries.
 */
import { normalizeSubdivision } from "@otta-sh/plugin";
import { subdivisionOptions } from "@otta-sh/plugin/subdivisions";
import { byLabel } from "./by-label.js";

/** The hidden field naming the country the place form's region list was
 *  rendered for (the address block without delivery). */
export const REGION_COUNTRY_FIELD = "regionCountry";
/** The same, for the delivery block's list. */
export const DELIVERY_REGION_COUNTRY_FIELD = "deliveryRegionCountry";

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

/** Does `country` have subdivisions — i.e. is there a list to pick from? */
export function hasRegionList(country: string | undefined): boolean {
	return subdivisionOptions((country ?? "").trim().toUpperCase()).length > 0;
}

/** True when the form's region was picked from a list rendered for ANOTHER
 *  country than the one now posted — so it must not be sent as this one's.
 *  `listCountry` undefined (a view without the hidden field) never differs. */
export function regionListIsStale(
	listCountry: string | undefined,
	country: string | undefined,
): boolean {
	if (listCountry === undefined) return false;
	return listCountry.trim().toUpperCase() !== (country ?? "").trim().toUpperCase();
}
