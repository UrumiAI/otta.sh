/**
 * The delivery country picker's options (ADR-0021): every ISO 3166-1 alpha-2
 * code the plugin prices by (its bundled CLDR list), labelled in the buyer's
 * language through `Intl.DisplayNames`.
 *
 * The label is a convenience and never a dependency: where the runtime cannot
 * name a region — `DisplayNames` missing or throwing, or a code it does not
 * know — the option shows the bare code. The VALUE is always the code, which is
 * all the plugin reads.
 */
import { COUNTRY_CODES } from "@otta-sh/plugin";

export interface CountryOption {
	code: string;
	label: string;
}

/** The part of `Intl.DisplayNames` this module uses. */
export interface RegionNames {
	of(code: string): string | undefined;
}

const displayNames = (locale: string): RegionNames =>
	new Intl.DisplayNames([locale], { type: "region" });

export function countryOptions(
	locale: string,
	makeNames: (locale: string) => RegionNames = displayNames,
): CountryOption[] {
	let names: RegionNames | null;
	try {
		names = makeNames(locale);
	} catch {
		names = null;
	}
	const label = (code: string): string => {
		try {
			return names?.of(code) ?? code;
		} catch {
			return code;
		}
	};
	return [...COUNTRY_CODES]
		.map((code) => ({ code, label: label(code) }))
		.toSorted((a, b) => a.label.localeCompare(b.label, locale));
}
