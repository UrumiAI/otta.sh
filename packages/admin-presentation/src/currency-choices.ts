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

/**
 * The store currency of a store that never saved one — the admin surfaces'
 * copy of the domain's `DEFAULT_STORE_CURRENCY` (they cannot import the domain;
 * `packages/plugin/test/money-parity.test.ts` pins the two equal).
 */
export const DEFAULT_STORE_CURRENCY = "USD";

/**
 * A picker's options when it must show `current`: {@link CURRENCY_CHOICES}, with
 * `current` prepended when the table does not list it (a saved code the table
 * later dropped) so the select always has an option matching its value. An
 * empty `current` (nothing chosen yet) adds nothing.
 */
export function currencyChoicesWith(current: string): readonly string[] {
	return current === "" || CURRENCY_CHOICES.includes(current)
		? CURRENCY_CHOICES
		: [current, ...CURRENCY_CHOICES];
}
