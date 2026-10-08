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
	return [...COUNTRY_CODES].map((code) => ({ code, label: label(code) })).toSorted(byLabel(locale));
}

/** A country code in the list's words — its label, else the code itself. */
export function countryName(code: string, options: readonly CountryOption[]): string {
	return options.find((option) => option.code === code)?.label ?? code;
}

/**
 * The one ordering of a pick list's options: by label, in `locale`'s collation
 * (as `localeCompare(…, locale)`), equal labels comparing 0. A locale the
 * runtime refuses falls back to plain code-unit order rather than throwing.
 * Shared by the country and the state/province lists.
 */
export function byLabel(locale: string): (a: { label: string }, b: { label: string }) => number {
	let collator: Intl.Collator | null;
	try {
		collator = new Intl.Collator(locale);
	} catch {
		collator = null;
	}
	return (a, b) =>
		collator !== null
			? collator.compare(a.label, b.label)
			: a.label < b.label
				? -1
				: a.label > b.label
					? 1
					: 0;
}
