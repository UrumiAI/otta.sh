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

/** Its two neighbours on every list screen. They live here rather than in a
 *  screen's copy module because they are the LIST's vocabulary, not any one
 *  screen's — six screens render all three, and having one of the three shared
 *  was the inconsistency INC-21's review found rather than a boundary. */
export const APPLY_FILTERS_LABEL = "Apply filters";
export const LOAD_MORE_LABEL = "Load more";

/**
 * `17 orders` · `1 order` · `25 orders on this page`, or `undefined` at zero.
 *
 * WHAT THE WIRE SUPPORTS, because the copy here is bounded by it. The three
 * admin list endpoints answer `{items, nextCursor, total}` — a page, a way to
 * ask for the next one, and (since INC-23) the exact size of the filtered set.
 * So the count this function renders is:
 *
 *  - the WHOLE (filtered) set — `17 orders` — whenever a `total` is present, on
 *    ANY page. It is a COUNT(*) under the same predicate as the page, so it is
 *    exact on page 3 of 3 as much as on page 1;
 *  - the WHOLE (filtered) set from the PAGE ITSELF — same wording — when there
 *    is no `total` but `complete` says the render is the first page of its
 *    filter AND there is no next cursor. Both halves are needed for that
 *    inference: page 1 of many counts a page, and page 3 of 3 knows nothing
 *    about pages 1 and 2 (keyset paging carries no running offset);
 *  - THIS PAGE otherwise — `25 orders on this page`, a smaller claim and a true
 *    one. That is the fallback for a service older than `total`, and for a
 *    level that deliberately WITHHOLDS one because it narrowed the fetched page
 *    itself (products' "Low stock only" — the service counted the unnarrowed
 *    set, so passing it would caption the rows on screen with a number that
 *    does not describe them).
 *
 * `total` IS VALIDATED HERE RATHER THAN TRUSTED: a non-integer, negative, or
 * below-the-page count is a service disagreeing with itself, and the
 * page-scoped fallback — a claim this render can back up on its own — is the
 * safe direction. `total < count` is impossible for a count and a page taken
 * under one predicate, but they are two statements, so a concurrent
 * insert/delete between them is the ordinary case; only the direction that
 * would UNDERSTATE the rows an operator can see is refused.
 *
 * NOTHING HERE INVENTS A TOTAL. A count that says the set is bigger than the
 * page must have been told so by the service; a renderer that guessed one would
 * produce exactly the number an operator reconciles against and loses.
 *
 * ZERO RENDERS NO COUNT AT ALL — zero ROWS, whatever the `total` says, and a
 * `total` of zero. `0 orders` is never emitted: at zero the zero state already
 * says it in words, and a count line repeating it is the "unknown rendered as
 * 0" failure in a costume. A `total` above an empty page is the same
 * self-contradiction from the other direction, and is suppressed with it.
 *
 * WHY IT LIVES IN THIS PACKAGE AND NOT IN `list-detail.ts`, where INC-23 wrote
 * it: because there are two list tiers now. The exact-count logic sitting on
 * the Block Kit side would have left the React Orders list saying
 * "25 orders on this page" while the Block Kit screen one sidebar entry away
 * said "137 orders" — a parity gap opening on the day INC-23 merged, on the
 * most-read line of the most-read screen. One implementation, both surfaces.
 *
 * `Intl.PluralRules` and `Intl.NumberFormat`, not `String(count)` and an `s` —
 * the count is the one rendered value a threaded locale must reach along with
 * everything else this package holds.
 */
export function rowCountLine(
	count: number,
	noun: RowNoun,
	opts: { complete: boolean; total?: number },
): string | undefined {
	// ZERO ROWS RENDER NO COUNT — `total` present or not. The alternative,
	// "17 orders" sitting immediately above "No orders yet" or "Nothing on this
	// page", is the screen contradicting itself in two adjacent blocks.
	if (count <= 0) return undefined;
	const usable =
		opts.total !== undefined &&
		Number.isSafeInteger(opts.total) &&
		opts.total >= 0 &&
		opts.total >= count;
	const n = usable ? (opts.total ?? 0) : count;
	if (n <= 0) return undefined;
	const word = COUNT_PLURALS.select(n) === "one" ? noun.one : noun.other;
	const formatted = COUNT_NUMERALS.format(n);
	return usable || opts.complete
		? `${formatted} ${word}`
		: `${formatted} ${word} ${PAGE_SCOPED_SUFFIX}`;
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
	/** The service's exact count of the filtered set (INC-23), when it reports
	 *  one and the caller has not narrowed the fetched page itself. Absent ⇒ the
	 *  count falls back to describing the page. See {@link rowCountLine}. */
	readonly total?: number;
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
		...(opts.total !== undefined ? { total: opts.total } : {}),
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
