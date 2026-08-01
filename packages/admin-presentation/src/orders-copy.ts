/**
 * The Orders screen's authored copy — the strings BOTH Orders screens put on
 * screen (INC-20; the detail half completed in INC-21).
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
 * INC-20 SHIPPED THE LIST HALF AND RECORDED THE REST AS A RIDER. It shared the
 * intro line, the two zero states and the reconciliation sentence, and left
 * roughly a dozen DETAIL strings hand-copied into `order-detail.tsx` with a
 * note saying so. That rider is closed here, and closing it FOUND FOUR
 * DIVERGENCES the note had predicted in the abstract — the two surfaces had
 * already drifted apart in the weeks between:
 *
 *  1. `“cancelled”` — the Block Kit copy uses typographic quotes and the React
 *     copy had straight ones, in both the cancel banner and the cancel confirm.
 *  2. The reconciliation note: Block Kit says "logs your decision only … Refund
 *     in Money if the buyer is owed one"; React had shortened it to the first
 *     clause and dropped the next step entirely.
 *  3. The over-refund refusal: Block Kit names the amount, the remaining
 *     ceiling AND what to enter instead; React said "Amount too high — … remains
 *     refundable. Nothing was changed." — the same fact without the instruction.
 *  4. The refunds-are-additive warning: Block Kit's opens with "Review the
 *     amount on the next step", which is TRUE ONLY THERE (the React screen
 *     collapsed the staged review into a confirm dialog). That one is a
 *     genuine per-surface difference, so the shared constant is the sentence
 *     they agree on and the Block Kit screen prefixes its own step reference —
 *     see {@link REFUND_ADDITIVE_NOTE}.
 *
 * Each is the kind of gap that is invisible until an operator reads both
 * screens, which is exactly what this migration asks them to do.
 *
 * WHEN THE BLOCK KIT SCREEN IS RETIRED, this module goes back to
 * `@otta-sh/admin-react` and stops being shared. It is a migration artefact and
 * should be read as one.
 */
import { fitBanner } from "./copy.js";
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
 * budget through no fault of the copy. `fitBanner` is applied here rather than
 * at each call site, so neither surface can render the untrimmed version.
 */
export function reconciliationAlertSentence(flag: string): string {
	return fitBanner(
		`Settlement flagged this order: ${flag}. Resolve it under Fulfilment — recording a resolution moves no money and does not change the order.`,
	);
}

// ── the detail: line items and totals ────────────────────────────────────────

/** M-5, stated ONCE on the screen: G3's snapshot guarantee, in the operator's
 *  words. An order's line titles and prices are what the buyer paid, and no
 *  product edit rewrites them. */
export const ORDER_LINES_SNAPSHOT_NOTE =
	"Titles and prices are what the buyer paid — later product edits never change them.";

/** An order with no line items at all. */
export const ORDER_LINES_EMPTY = "No line items.";

// ── the detail: secondary surfaces that failed (E-1 / E-3) ───────────────────
//
// Each names WHAT failed, WHAT is unaffected, and the ONE next step — and never
// reads like a successful empty, which is the failure mode E-3 exists to
// prevent. A degraded read renders one line inside its own panel; it never
// blanks the detail and never fails the screen.

export const CUSTOMER_CONTEXT_UNAVAILABLE =
	"Customer context unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.";

export const TIMELINE_UNAVAILABLE =
	"Timeline unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.";

export const REFUNDS_UNAVAILABLE =
	"Refunds are unavailable right now — the refunds service could not be reached. The order itself is unaffected; reload to try again.";

/** NOT a failure: an order that predates address capture, or a digital-only
 *  one. The last clause is the one that matters operationally — the customer
 *  panel's address book is context, never where THIS order shipped. */
export const SHIPPING_ADDRESS_ABSENT =
	"No shipping address captured — this order predates capture, or is digital-only. The profile book under Order is context only, never where this order shipped.";

/** A timeline that loaded and holds nothing yet. */
export const TIMELINE_EMPTY = "No timeline activity yet.";

// ── the detail: reconciliation ───────────────────────────────────────────────

/** DA-4: this records a decision and moves no money — say so, and never style
 *  it as danger. The last clause is the next step, and dropping it (as the
 *  React tier's hand-copy had) leaves an operator who owes the buyer money with
 *  nowhere to go. */
export const RESOLVE_RECONCILIATION_NOTE =
	"Recording a resolution logs your decision only — it moves no money and does not change the order. Refund in Money if the buyer is owed one.";

// ── the detail: cancellation ─────────────────────────────────────────────────

/** DA-3 state 1's required alert on the Cancel group. */
export const CANCEL_BANNER = {
	title: "Cancelling is permanent",
	description:
		"Cancelling moves this order to “cancelled”, emails the buyer and releases the held stock. It cannot be undone.",
} as const;

/** The line above the four reason buttons. */
export const CANCEL_PICK_REASON = "Pick the reason — cancelling is immediate.";

/** The cancel confirm dialog's fixed parts. The sentence is
 *  {@link cancelConfirmText}, which needs the reason. */
export const CANCEL_CONFIRM = {
	title: "Cancel this order?",
	confirm: "Yes, cancel the order",
	deny: "Keep the order",
} as const;

/** The cancel confirm's sentence, named by the human REASON LABEL rather than
 *  the wire value — the operator picked a label and must read the same one
 *  back. */
export function cancelConfirmText(reasonLabel: string): string {
	return `Cancel this order as “${reasonLabel}”? This is permanent — the order cannot be un-cancelled, and the held stock is released.`;
}

// ── the detail: the refunded transition ──────────────────────────────────────

/** The one bookkeeping transition dangerous enough to confirm. The sentence's
 *  whole job is to separate the LEDGER from the MONEY: marking an order
 *  refunded moves nothing, and an operator who believes otherwise has just
 *  told a buyer they were paid. */
export const MARK_REFUNDED_CONFIRM = {
	title: "Mark this order refunded?",
	text: "Marks the order refunded for bookkeeping. It does not move money — record the money in Money → Refunds.",
	confirm: "Yes, mark refunded",
	deny: "Keep as is",
} as const;

// ── the detail: refunds ──────────────────────────────────────────────────────

/** DA-7: no control at all, one line naming the reason. */
export const FULLY_REFUNDED_NOTE = "Fully refunded — nothing left to refund.";

/**
 * The additive-refunds warning, and the ONE genuine per-surface split in this
 * module.
 *
 * Both screens must say that recording a refund twice records two refunds. Only
 * the BLOCK KIT screen has a "next step" to point at — its DA-3 flow stages the
 * amount server-side and renders a confirm button on a second render — so it
 * prefixes {@link REFUND_REVIEW_STEP_PREFIX} to this and the React screen does
 * not. Sharing the sentence and splitting the prefix is what keeps the shared
 * half honest; sharing the whole thing would have put a step reference on a
 * screen that has no such step.
 */
export const REFUND_ADDITIVE_NOTE =
	"Refunds are additive: recording one twice records two refunds.";

/** The Block Kit screen's own lead-in to {@link REFUND_ADDITIVE_NOTE}. */
export const REFUND_REVIEW_STEP_PREFIX = "Review the amount on the next step.";

/** The partial-refund group's alert title. */
export const REFUND_PARTIAL_BANNER_TITLE = "A recorded refund cannot be reversed here";

/** A refund amount that does not parse to a positive amount. Both surfaces
 *  refuse before anything is sent, and both say the same thing — including the
 *  clause that answers the operator's actual question. */
export const REFUND_AMOUNT_INVALID =
	"Enter a valid refund amount greater than zero (e.g. 19.99). Nothing was changed.";

/** A refund with nobody recorded as issuing it. */
export const REFUND_BY_REQUIRED =
	"Enter who is issuing or recording this refund. Nothing was changed.";

/** The over-ceiling refusal. Takes ALREADY-FORMATTED money — the caller has the
 *  order's currency and `formatAmount`; this module states the sentence, not
 *  the money. Names what to enter INSTEAD, which is the half a bare
 *  "amount too high" leaves the operator to work out. */
export function refundTooHighText(amount: string, remaining: string): string {
	return `${amount} is more than the ${remaining} that remains refundable on this order. Enter ${remaining} or less.`;
}

/** The title above {@link refundTooHighText}. */
export const REFUND_TOO_HIGH_TITLE = "Amount too high";

// ── the detail: group labels ─────────────────────────────────────────────────
//
// D-6: a group's label carries its ANSWER, and D-6a says a destructive group's
// label carries the CONSEQUENCE rather than the verb (X-35's bare-verb check).
// Shared for the same reason every string above is: two Orders screens in one
// sidebar must not label the same group two ways.

/** The Cancel group. Names what cancelling COSTS, not merely that it cancels. */
export const CANCEL_GROUP_LABEL = "Cancel order — permanent, releases held stock";

/** The partial-refund group. A bare noun would make the most dangerous control
 *  on the panel its quietest thing. */
export const REFUND_PARTIAL_GROUP_LABEL = "Refund a different amount — cannot be reversed";

/** The Refunds group at a ZERO ceiling. D-6b replaces the degenerate
 *  `$0.00 of $0.00` ratio with the fact itself, because a ratio whose
 *  denominator is zero tells an operator nothing and reads like a bug. */
export const REFUNDS_GROUP_EMPTY_LABEL = "Refunds — nothing captured, nothing to refund";

/** The Refunds group's ratio label. Takes ALREADY-FORMATTED money: this module
 *  states the sentence, the caller states the currency. */
export function refundsGroupLabel(refunded: string, ceiling: string): string {
	return `Refunds — ${refunded} of ${ceiling} refunded`;
}
