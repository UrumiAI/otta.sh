/**
 * The ORDER and WORDING every admin currency picker uses — the React pricing
 * card's first-price picker and the Block Kit Settings page's store-currency
 * select read the same list, so the two screens offer currencies identically.
 */
import { SUPPORTED_CURRENCIES } from "./currencies.js";

/** The currencies offered first, in this order — the list the picker showed
 *  before the currency table existed, kept at the top so it reads as it did. */
const LEADING_CHOICES: readonly string[] = [
	"USD",
	"EUR",
	"GBP",
	"CAD",
	"AUD",
	"NZD",
	"INR",
	"SGD",
	"CHF",
	"SEK",
];

/** EVERY currency in the currency table, the familiar ten first and the rest by
 *  code. */
export const CURRENCY_CHOICES: readonly string[] = [
	...LEADING_CHOICES,
	...SUPPORTED_CURRENCIES.map((row) => row.code)
		.filter((code) => !LEADING_CHOICES.includes(code))
		.toSorted(),
];

/** A picker's label for a code: `USD — US Dollar` (the bare code for one the
 *  table does not list). */
export function currencyChoiceLabel(code: string): string {
	const row = SUPPORTED_CURRENCIES.find((r) => r.code === code);
	return row === undefined ? code : `${code} — ${row.name}`;
}
