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
 * The text a totals row prints — pre-formatted money, or honest prose.
 *
 * The `NOT_APPLICABLE_LABEL` branch is the §7 guarantee: the raw label is
 * never returned for it, with or without a `fallback`. The constant is
 * imported rather than string-matched against a literal, so if the plugin ever
 * changes what "not applicable" looks like this keeps working.
 */
export function sumRowText(row: SumRow): string {
	if (!isUncalculated(row.amount)) return row.amount.label;
	if (row.amount.label === NOT_APPLICABLE_LABEL) return row.fallback ?? NOT_APPLIED_LABEL;
	return row.fallback ?? row.amount.label;
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
