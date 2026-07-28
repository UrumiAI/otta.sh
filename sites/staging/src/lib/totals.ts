/**
 * The totals block's rules (docs/theme/TEMPERED.md §7).
 *
 * The plugin's `CheckoutAmountView` already carries the distinction the theme
 * needs — `money: null` means "this store did not calculate it", `money`
 * present means "this is a real figure, even if it is zero". So the theme never
 * parses a string to decide how to render it, and there is exactly one way for
 * "Not calculated" to become "$0.00": someone deleting this rule.
 *
 * The second job here is the footnote. §7 requires that when
 * `totalExcludesUncalculated` is set, the line under the total says WHICH parts
 * are missing — "this total may be incomplete" tells a shopper nothing.
 */
import { NOT_APPLICABLE_LABEL, NOT_CALCULATED_LABEL, type CheckoutAmountView } from "@urumi/plugin";

/**
 * What a not-applicable row says when the page supplies nothing better.
 *
 * The view model's `NOT_APPLICABLE_LABEL` is a bare "—", and §7 forbids
 * exactly that: on its own a dash is indistinguishable from an outage, from a
 * free item, and from a row this store cannot price. The page usually knows
 * why the row is empty and passes a `fallback` ("No coupon applied"); this is
 * what prints when it does not.
 *
 * It is a DEFAULT rather than an optional improvement on purpose. The failure
 * mode being guarded against is someone omitting an optional prop — which is
 * how the discount row, the one that hits this path on every ordinary order,
 * shipped a bare dash in the first place.
 */
export const NOT_APPLIED_LABEL = "Not applied";

export interface SumRow {
	/** The row's name — "Subtotal", "Shipping", "Tax". */
	label: string;
	/** Straight off the view model. The component renders `amount.label`; it
	 *  never builds a money string (§7). */
	amount: CheckoutAmountView;
	/**
	 * Prose to print INSTEAD of `amount.label` when nothing was computed, for a
	 * page that knows WHY the row is empty ("No coupon applied").
	 *
	 * Optional, and safe to omit: a bare "—" can never reach the screen either
	 * way — see `NOT_APPLIED_LABEL`.
	 */
	fallback?: string;
}

/** Was this amount calculated at all? The view model says so; nothing here
 *  inspects the string. */
export function isUncalculated(amount: CheckoutAmountView): boolean {
	return amount.money === null;
}

/**
 * Does this string actually SAY anything — is there a letter or a digit in it?
 *
 * The dash rule §7 states is really a rule about substance: `""`, `"   "`,
 * `"—"`, `"–"` and `"-"` are all indistinguishable from an outage on screen,
 * and they are all one keystroke apart from each other, so keying on the em
 * dash alone guards one of five spellings of the same mistake. Unicode
 * properties rather than `[A-Za-z0-9]`: a store rendering "非課税" or "٤٠٫٠٠"
 * is saying something.
 */
function saysSomething(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text);
}

/** The last gate before a money cell reaches the screen. Anything that does not
 *  say something becomes the honest default rather than a mark on a page. */
function orNotApplied(text: string | undefined): string {
	return text !== undefined && saysSomething(text) ? text : NOT_APPLIED_LABEL;
}

/**
 * The text a totals row prints — pre-formatted money, or honest prose.
 *
 * The `NOT_APPLICABLE_LABEL` branch is the §7 guarantee: the raw label is
 * never returned for it, with or without a `fallback`. The constant is
 * imported rather than string-matched against a literal, so if the plugin ever
 * changes what "not applicable" looks like this keeps working.
 *
 * Both uncalculated branches then pass through `orNotApplied`, which is the
 * backstop for the case the constant cannot cover: a `fallback` that is itself
 * blank, or a plugin label that is a different dash from the one we import.
 */
export function sumRowText(row: SumRow): string {
	if (!isUncalculated(row.amount)) return row.amount.label;
	if (row.amount.label === NOT_APPLICABLE_LABEL) return orNotApplied(row.fallback);
	return orNotApplied(row.fallback ?? row.amount.label);
}

/**
 * The text a LINE-ITEM money cell prints (§7), for `Ledger`.
 *
 * A line item does not arrive as a `CheckoutAmountView` — the cart wire hands
 * the page a plain string that is either `lineTotal.formatted` or prose
 * (`cart-view.ts`'s "priced at checkout"). That leaves one gap the totals block
 * does not have: `cart-view.ts` also exports `UNAVAILABLE_LABEL = "—"` for the
 * degraded case, and a component that printed its input verbatim would put
 * exactly the lone dash §7 forbids in the money column of every cart row.
 *
 * So the same substitution `sumRowText` applies to a totals row applies here: a
 * cell that says nothing becomes the caller's own prose, or the honest default.
 * Real money and real prose are printed untouched — a `fallback` never
 * overrides a cell that already has something to say.
 */
export function moneyCellText(money: string, fallback?: string): string {
	return saysSomething(money) ? money : orNotApplied(fallback);
}

/**
 * Is this cell PROSE rather than a figure, judged by the value itself?
 *
 * `Ledger` sets prose smaller and muted so it cannot be misread as an amount,
 * and it used to decide that from a boolean the caller passed in. A flag the
 * caller forgets is how the dash shipped in the first place, so the value gets
 * the deciding vote: a formatted money string always carries a digit, and
 * nothing this theme prints as prose does.
 */
export function isUnpricedText(text: string): boolean {
	return !/\p{N}/u.test(text);
}

/** Lower-cased names of the rows this store never configured. Deliberately
 *  keyed on `NOT_CALCULATED_LABEL` and not on "has no money": a discount that
 *  simply does not apply to this order is not an unconfigured store. */
function uncalculatedNames(rows: SumRow[]): string[] {
	return rows
		.filter((row) => isUncalculated(row.amount) && row.amount.label === NOT_CALCULATED_LABEL)
		.map((row) => row.label.toLowerCase());
}

/**
 * The line under the total, or `null` when the total is complete.
 *
 * `excludesUncalculated` is the view model's own `totalExcludesUncalculated`
 * flag and has the last word — the theme reports what the pricing pipeline
 * says, it does not re-derive it from the rows it happens to have been handed.
 *
 * Which leaves one hole worth closing: the flag can be set while none of the
 * rows PASSED IN carries the not-calculated label — a page that renders a
 * shortened totals block, or a pipeline that grows a component this theme does
 * not list yet. Naming nothing would be right; saying nothing would not, since
 * the flag means the total is incomplete and a shopper is about to act on it.
 * So that case gets a footnote that admits the gap without inventing a name
 * for it.
 */
export function uncalculatedFootnote(rows: SumRow[], excludesUncalculated: boolean): string | null {
	if (!excludesUncalculated) return null;
	const names = uncalculatedNames(rows);
	if (names.length === 0) {
		return "This total doesn't include everything yet — some amounts aren't calculated on this store.";
	}
	const list =
		names.length === 1
			? names[0]
			: `${names.slice(0, -1).join(", ")} or ${names[names.length - 1] ?? ""}`;
	const it = names.length === 1 ? "it" : "them";
	return `This total doesn't include ${list} — this store hasn't set ${it} up yet.`;
}
