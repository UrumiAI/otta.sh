/**
 * Copy primitives shared by every screen's authored strings — the budgets, the
 * trimmers, and the one pluralization both surfaces spell the same way.
 *
 * WHY IT IS ITS OWN MODULE. `fit`/`fitBanner`/`BANNER_BUDGET` arrived in
 * `orders-copy.ts` (INC-20) because Orders was the only screen with copy in this
 * package. INC-21 adds `products-copy.ts`, whose remove-stock confirm needs the
 * same trimmer against the ACCORDION budget rather than the banner one — and
 * `products-copy.ts` importing `orders-copy.ts` for it would say something false
 * about how the two screens relate. The budgets belong to §1, not to Orders.
 *
 * The public export names are unchanged: `@otta-sh/admin-presentation` still
 * exports `BANNER_BUDGET`, `fit` and `fitBanner`, and `orders-copy.ts` still
 * uses them. Only the file they live in moved.
 */

/**
 * What an ABSENT value renders as, anywhere on either surface.
 *
 * ONE GLYPH, ONE DEFINITION, THREE NAMED HOMES. `UNFORMATTABLE` (money) and
 * `ON_HAND_UNKNOWN` (stock) both derive from this, because they mean different
 * things and must be able to diverge — a console that decided money should read
 * `not priced` while stock kept the dash would change one constant, not hunt
 * for a character. Everything else that is simply unset (a SKU nobody has
 * assigned, a weight nobody measured) uses this directly rather than borrowing
 * one of the two, which is what INC-21's review caught: three cells were
 * rendering "no stock figure" for a value that had nothing to do with stock.
 *
 * ABSENT IS NEVER ZERO. That rule is the reason all three exist.
 */
export const ABSENT = "—";

/**
 * The label on the control that re-runs a load that failed, and what that
 * control reads while the re-run is in flight.
 *
 * HERE RATHER THAN BESIDE THE LIST VOCABULARY, because a retry is not a list
 * affordance: the product detail offers one too, beside its Back button, and a
 * detail screen importing the list module for one word would say something
 * false about how the two relate. Every failed load in the console offers the
 * same word.
 */
export const RETRY_LABEL = "Retry";
export const RETRYING_LABEL = "Retrying…";

/** §1's banner prose budget. */
export const BANNER_BUDGET = 240;

/** §1's accordion-label budget (X-11) — the ceiling a group label, and the
 *  confirm-dialog TITLE that mirrors one, must stay under. */
export const LABEL_BUDGET = 60;

/** Trim a string to `max`, ellipsis included — for the places a rendered
 *  string's length depends on SERVICE DATA and could otherwise blow a §1
 *  budget. */
export function fit(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** {@link fit} at {@link BANNER_BUDGET}. */
export function fitBanner(text: string): string {
	return fit(text, BANNER_BUDGET);
}

/** {@link fit} at {@link LABEL_BUDGET}. */
export function fitLabel(text: string): string {
	return fit(text, LABEL_BUDGET);
}

/**
 * `unit` / `units`, for the several places a stock quantity is spoken.
 *
 * A one-line helper rather than an inline ternary at each site because the
 * SITES are what matter: the confirm dialog's title, its sentence, the button
 * on it and the outcome banner all name the same quantity, and an operator who
 * reads "Remove 1 units?" on one of them and "1 unit" on the next is being
 * shown two renderings of one number. Not localized — the same narrow claim
 * `rowCountLine`'s `RowNoun` makes: single-point localizABILITY, and the day a
 * viewer locale is threaded this becomes an `Intl.PluralRules` call beside that
 * one.
 */
export function unitWord(count: number): string {
	return count === 1 ? "unit" : "units";
}

/** Separator between the values on a D-6 label. */
export const VALUE_SEPARATOR = " · ";

/**
 * A D-6 `<group> — <value> · <value>` label, kept inside the {@link LABEL_BUDGET}
 * by shortening a VALUE rather than the tail.
 *
 * WHY NOT JUST `fitLabel`. Right-truncation eats the LAST value outright: a
 * 40-character tax-class slug would silently delete `· 3200 g` and leave a label
 * that looks complete. The whole point of a D-6 label is that it carries the
 * values, so the truncation has to cost the value that has the most to give —
 * the longest one — and only by the overflow, leaving every other segment (the
 * tail included) intact. When even that is not enough (a prefix that alone
 * exceeds the budget — no caller has one) it falls back to plain
 * right-truncation, which is still inside the budget.
 *
 * SHARED SINCE INC-21 because the React Pricing & inventory screen renders the
 * same three group labels. Its `<summary>` could wrap where a Block Kit
 * accordion label cannot, but an operator comparing the two screens reads the
 * same label on both or learns that the console has two answers.
 */
export function valueLabel(prefix: string, values: readonly string[]): string {
	if (values.length === 0) return fitLabel(prefix);
	const full = `${prefix} — ${values.join(VALUE_SEPARATOR)}`;
	if (full.length <= LABEL_BUDGET) return full;
	let longest = 0;
	values.forEach((value, index) => {
		if (value.length > (values[longest] ?? "").length) longest = index;
	});
	const room = (values[longest] ?? "").length - (full.length - LABEL_BUDGET) - 1;
	if (room < 1) return fitLabel(full);
	const shortened = values.map((value, index) =>
		index === longest ? `${value.slice(0, room)}…` : value,
	);
	return `${prefix} — ${shortened.join(VALUE_SEPARATOR)}`;
}

/**
 * The readable buyer reference for anywhere an order names its buyer AS
 * PLAIN TEXT — the list's Customer cell, the detail heading — NEVER the
 * opaque `customerId` uuid a wire payload also carries.
 *
 * ONE HOME, review-mandated. This started as two byte-identical functions,
 * one declared in `orders-list.tsx` and one in `order-detail.tsx`, encoding
 * the same rule with no shared import between the sibling files. THE REACT
 * ORDERS SCREEN IS THE ONLY CONSUMER TODAY — ADR-0015 retired the Block Kit
 * Orders screen, so this is not a cross-surface-drift guard the way
 * `orderStateCell` (`order-status.ts`) still is; it exists so the LIST and
 * the DETAIL, both React, cannot drift from each other on this one rule.
 * Filed beside `ABSENT` and `fit` rather than in `order-status.ts`: it is a
 * value-formatting primitive, not part of the order-state vocabulary that
 * module owns.
 *
 * Absent, empty, or WHITESPACE-ONLY renders {@link ABSENT} — matching this
 * console's existing "blank means absent" convention
 * (`order-detail.tsx`'s `refundedBy.trim().length === 0`) — never a blank
 * cell/heading and never the literal string "null". THE RETURNED VALUE IS
 * ITSELF TRIMMED, not merely trim-CHECKED: an incidental leading/trailing
 * space is exactly the kind of thing an operator's copy-paste into a
 * downstream field should never carry, and the earlier cut of this function
 * trimmed only to decide, then returned the untrimmed original — invisible
 * in rendered HTML, and a defect all the same.
 *
 * THIS IS "WHAT TO PRINT", NOT "WHO A REFUND ACTUALLY GOES TO". A
 * destructive confirmation is a stricter, different question — it requires a
 * PROVEN identity (a verified email on a claimed account, not merely a
 * present one) before it will skip its own clamp, and never uses
 * {@link ABSENT} (an em dash is a field marker, not a word in a sentence) —
 * so it is answered locally in `order-detail.tsx`, not here.
 */
export function buyerReferenceText(buyerRef: string | null | undefined): string {
	if (typeof buyerRef !== "string") return ABSENT;
	const trimmed = buyerRef.trim();
	return trimmed.length > 0 ? trimmed : ABSENT;
}
