/**
 * Counter's one typographic move on money (brief "Personality move"): the
 * figure at the title's weight, the currency sign one step smaller and lighter
 * — a retail shelf-label detail.
 *
 * This SPLITS a price the page already formatted (docs/theme/TEMPERED.md §7);
 * it never builds one. Whatever sits before the first digit or after the last
 * one is the sign ("$", "US$", "€", "CHF ", " kr"), the rest is the figure.
 * Anything it cannot read that way comes back whole as the figure, so the worst
 * case is Tempered-plain money, never a wrong one.
 */

export interface PriceParts {
	/** The sign before the figure ("$", "CHF "), or "". */
	lead: string;
	figure: string;
	/** The sign after the figure (" €"), or "". */
	trail: string;
}

export function priceParts(formatted: string): PriceParts {
	const match = /^(\D*?)(\d(?:[\d.,'\s  ]*\d)?)(\D*)$/u.exec(formatted.trim());
	if (match === null) return { lead: "", figure: formatted, trail: "" };
	const [, lead = "", figure = "", trail = ""] = match;
	return { lead, figure, trail };
}
