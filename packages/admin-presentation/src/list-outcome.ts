/**
 * "How many rows, and what to say when there are none" — the console's list
 * outcome ladder, shared by both admin surfaces (INC-20 review).
 *
 * WHY THIS MOVED. The ladder was a Block Kit concern while there was one list
 * tier. INC-20's React Orders screen renders THE SAME LIST, and its first cut
 * reimplemented a two-branch version of a FIVE-outcome decision — so a page-2
 * miss claimed "No orders yet" (a whole-collection claim that render has not
 * earned) and a zero-row page with a cursor still behind it hid `Load more`
 * behind an empty state, stranding an operator mid-scan. Neither is a React bug;
 * both are what happens when a decision this carefully argued is written twice.
 *
 * SO THE DECISION IS SHARED AND THE RENDERING IS NOT. `listOutcome` returns a
 * discriminated union naming WHICH outcome and WHICH words; `list-detail.ts`
 * turns that into Block Kit blocks and `orders-list.tsx` turns it into React.
 * Both surfaces therefore agree on the hard part by construction, while each
 * keeps the part only it can do (a `Clear filters` button carrying a nav path,
 * versus an `onClick`).
 *
 * IO-FREE — pure `Intl` and string work, safe inside the workerd sandbox (G7)
 * and in a browser.
 */
import { DATE_LOCALE } from "./datetime.js";

/** How a screen names one row and many. Six screens describe their rows
 *  differently, and a generic "results" would be the half-measure this
 *  replaces. */
export interface RowNoun {
	readonly one: string;
	readonly other: string;
}

/** The pinned locale the count is pluralized in — deliberately the console's ONE
 *  locale knob ({@link DATE_LOCALE}), so the day a real viewer locale is threaded
 *  through, the count follows the dates instead of needing its own hunt. Same
 *  narrow claim as the date dialect makes (G6): this is single-point
 *  LOCALIZABILITY, not a localized console. */
const COUNT_PLURALS = new Intl.PluralRules(DATE_LOCALE);

/** The numeral's own formatter, so a locale that does not use ASCII digits gets
 *  its own the day one is threaded. Hoisted to module scope like the date
 *  dialect's three formatters: an `Intl` constructor is the expensive half, and
 *  building one per rendered list would pay it on every interaction. */
const COUNT_NUMERALS = new Intl.NumberFormat(DATE_LOCALE);

/** The suffix that keeps a page-scoped count from reading as a whole-set one. */
export const PAGE_SCOPED_SUFFIX = "on this page";

/** The trailing half of a "there is another page behind this one" note. */
export const SCAN_FURTHER = "Load more scans further.";

/** The lead half of that note when NO filter is on — a page that came back empty
 *  with a cursor still behind it is not an empty collection, so it must not
 *  borrow the filtered wording (nor the empty state). */
export const NOTHING_ON_PAGE = "Nothing on this page.";

/** The label of the clear-filters affordance, on both surfaces. */
export const CLEAR_FILTERS_LABEL = "Clear filters";

/**
 * `17 orders` · `1 order` · `25 orders on this page`, or `undefined` at zero.
 *
 * `complete` is the caller's claim that this count covers the whole filtered set
 * (`firstPage && no next cursor`). Getting it wrong is the one way this function
 * can lie, which is why {@link listOutcome} derives it rather than letting a
 * screen assert it.
 *
 * `Intl.PluralRules` and `Intl.NumberFormat`, not `String(count)` and an `s`.
 * The React tier's first cut used both, which quietly made the count the one
 * rendered value in this console that a threaded locale would NOT reach — the
 * exact single-point-localizability property this package exists to hold.
 */
export function rowCountLine(
	count: number,
	noun: RowNoun,
	opts: { complete: boolean },
): string | undefined {
	if (count <= 0) return undefined;
	const word = COUNT_PLURALS.select(count) === "one" ? noun.one : noun.other;
	const n = COUNT_NUMERALS.format(count);
	return opts.complete ? `${n} ${word}` : `${n} ${word} ${PAGE_SCOPED_SUFFIX}`;
}

/** The wording of ONE zero state. Screens author every string. */
export interface ZeroStateCopy {
	readonly title: string;
	readonly description: string;
}

/**
 * Zero rows, no filter, and NOT the first page — the operator paged forward and
 * the next page came back empty.
 *
 * IT GETS ITS OWN WORDING BECAUSE THE SCREEN'S DOES NOT APPLY. A screen's
 * `empty` copy ("No orders yet") is a claim about the WHOLE COLLECTION, and on
 * page 2+ the renderer has no standing to make one — page 1 had rows. That is
 * the same species of unearned claim the count line already refuses, and it is
 * reachable in a live store: two look-ahead reads either side of a concurrent
 * delete leave a cursor pointing past the last row.
 *
 * Deliberately offers NOTHING to click: no filter is on, so there is nothing to
 * clear, and neither surface has a "back to the first page" control to
 * fabricate.
 */
export const PAGE_ZERO: ZeroStateCopy = {
	title: "Nothing on this page",
	description:
		"This page came back empty. The list may have changed since the page before it was loaded — reload the screen to see it as it stands now.",
};

/** What the zero state offers the operator, which differs as much as the words
 *  do: a narrowed-to-nothing list offers the undo, an empty collection offers
 *  the way in, and a page that ran off the end offers neither. */
export type ZeroStateOffer = "clear-filters" | "way-in" | "none";

/**
 * FIVE OUTCOMES, and the third is the one that is easy to get wrong.
 *
 *  1. **Rows** (`kind: "rows"`) — render the table as usual.
 *  2. **Zero, unfiltered, FIRST page, no next page** (`kind: "empty"`, offer
 *     `way-in`) — the collection is empty; the empty state REPLACES the table.
 *  2b. **Zero, unfiltered, NOT the first page** (`kind: "empty"`, offer `none`)
 *     — the same shape with {@link PAGE_ZERO}'s page-scoped wording.
 *  3. **Zero with ANOTHER PAGE BEHIND IT** (`kind: "scan"`) — NO empty state and
 *     no table `empty_text`, plus a scan note. On Block Kit the pinned renderer
 *     short-circuits a zero-row table carrying `empty_text` to a bare `<p>` AND
 *     takes `Load more` with it; on React the equivalent mistake is rendering an
 *     empty state that hides the `Load more` button beneath it. Both strand an
 *     operator mid-scan on a page that is not the end of anything.
 *  4. **Zero, filtered, last page** (`kind: "empty"`, offer `clear-filters`) —
 *     the screen's `noMatch` copy plus the undo, replacing the table.
 */
export type ListOutcome =
	| { readonly kind: "rows"; readonly countLine: string | undefined; readonly emptyText: string }
	| { readonly kind: "scan"; readonly countLine: undefined; readonly scanNote: string }
	| {
			readonly kind: "empty";
			readonly countLine: undefined;
			readonly title: string;
			readonly description: string;
			readonly offer: ZeroStateOffer;
			readonly emptyText: string;
	  };

export interface ListOutcomeOptions {
	/** Rows on the page about to be rendered. */
	readonly count: number;
	/** Whether any filter is on — the same boolean the active-filter summary is
	 *  derived from, so the count line, the summary and the zero state cannot
	 *  disagree about it. */
	readonly filtered: boolean;
	readonly firstPage: boolean;
	/** Whether a page remains behind this one. */
	readonly hasNext: boolean;
	readonly noun: RowNoun;
	/** Zero rows and NO filter on: the collection itself is empty. */
	readonly empty: ZeroStateCopy;
	/** Zero rows WITH a filter on: the operator narrowed to nothing. */
	readonly noMatch: ZeroStateCopy & {
		/** The table's empty text for this filter — still needed, because a table
		 *  WITH rows carries it against a later render. */
		readonly emptyText: string;
		/** The "another page remains" note, when the screen has better words for
		 *  it than the default. */
		readonly scanNote?: string;
	};
}

export function listOutcome(opts: ListOutcomeOptions): ListOutcome {
	const countLine = rowCountLine(opts.count, opts.noun, {
		complete: opts.firstPage && !opts.hasNext,
	});
	if (opts.count > 0) {
		return { kind: "rows", countLine, emptyText: opts.noMatch.emptyText };
	}
	if (opts.hasNext) {
		const lead = opts.filtered ? opts.noMatch.emptyText : NOTHING_ON_PAGE;
		return {
			kind: "scan",
			countLine: undefined,
			scanNote: opts.noMatch.scanNote ?? `${lead} ${SCAN_FURTHER}`,
		};
	}
	// THE SCREEN'S `empty` COPY IS A WHOLE-COLLECTION CLAIM, so it is gated on
	// `firstPage` exactly as the count line is. "No orders yet" on page 2 is the
	// same unearned claim as "17 orders" would be there.
	//
	// `noMatch` is NOT gated the same way, and the asymmetry is deliberate: it
	// names the operator's OWN filter rather than the collection, and the undo it
	// carries is the right next act on any page.
	const copy = opts.filtered ? opts.noMatch : opts.firstPage ? opts.empty : PAGE_ZERO;
	const offer: ZeroStateOffer = opts.filtered
		? "clear-filters"
		: opts.firstPage
			? "way-in"
			: "none";
	return {
		kind: "empty",
		countLine: undefined,
		title: copy.title,
		description: copy.description,
		offer,
		emptyText: opts.noMatch.emptyText,
	};
}
