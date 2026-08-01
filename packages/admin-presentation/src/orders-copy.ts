/**
 * The Orders screen's authored copy — the strings BOTH Orders screens put on
 * screen (INC-20 review).
 *
 * WHY A SCREEN'S COPY IS IN A SHARED PACKAGE AT ALL. Normally it would not be:
 * copy belongs with the screen that renders it. But for the length of this
 * migration there are TWO Orders screens rendering the same records side by
 * side in the same sidebar, and ADR-0014 requires both to keep working until
 * the replacement is proven. That makes every string here a cross-surface
 * contract rather than a screen's private business: an operator comparing the
 * two — which is the entire point of shipping them together — must not have to
 * work out whether two different sentences describe the same state.
 *
 * The React tier's first cut copied these by hand. That is exactly how the
 * Block Kit screen came to have three date formats and two money formatters,
 * and the answer here is the answer INC-13 and INC-20 already gave: one
 * definition, two importers, and a test on each side that fails when they
 * disagree.
 *
 * WHEN THE BLOCK KIT SCREEN IS RETIRED, this module goes back to
 * `@otta-sh/admin-react` and stops being shared. It is a migration artefact and
 * should be read as one.
 */
import type { RowNoun, ZeroStateCopy } from "./list-outcome.js";

/** How the Orders list names one row and many. */
export const ORDERS_NOUN: RowNoun = { one: "order", other: "orders" };

/**
 * The standing half of the list's intro line — the row count goes in front of
 * it.
 *
 * 101 chars; the longest count line this screen can produce
 * (`25 orders on this page`) puts the whole line at 127 ≤ 140 (X-11).
 * "View-only" is gone: this console cancels, refunds, fulfils and annotates.
 */
export const ORDERS_LIST_INTRO =
	"Filter, open an order, and move it through its status flow. Money in the order's currency; dates UTC.";

/** Zero rows, no filter, first page: the collection itself is empty.
 *  Non-accusatory by construction — nothing has gone wrong — and it offers no
 *  way IN, because orders are not created in the admin (E-2). */
export const ORDERS_EMPTY: ZeroStateCopy = {
	title: "No orders yet",
	description: "Orders appear here as buyers check out.",
};

/** Zero rows with a filter on: the operator narrowed to nothing, so the way out
 *  is the filter. */
export const ORDERS_NO_MATCH: ZeroStateCopy & { readonly emptyText: string } = {
	title: "No orders match these filters",
	description:
		"Nothing came back for the filters you set. Clear them to go back to every order, or widen one and apply again.",
	emptyText: "No orders match these filters.",
};

/**
 * The reconciliation alert's sentence, on the order detail.
 *
 * It names the flag the SERVICE produced, so its length depends on service data
 * and it is the one banner on this screen that can blow §1's 240-character
 * budget through no fault of the copy. {@link fitBanner} is applied here rather
 * than at each call site, so neither surface can render the untrimmed version.
 */
export function reconciliationAlertSentence(flag: string): string {
	return fitBanner(
		`Settlement flagged this order: ${flag}. Resolve it under Fulfilment — recording a resolution moves no money and does not change the order.`,
	);
}

/** §1's banner prose budget. */
export const BANNER_BUDGET = 240;

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
