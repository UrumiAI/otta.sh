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
import { ABSENT } from "./copy.js";
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

/**
 * The same qualifier for a list that KEEPS the pages it has loaded.
 *
 * "on this page" is exactly true of a surface where the next page replaces the
 * one before it, and false the moment two pages are on screen at once: forty
 * rows drawn from two requests are not "on this page", they are what has been
 * loaded so far — still a smaller claim than the whole set, which is the job the
 * suffix exists to do.
 *
 * IT IS OPT-IN, AND THE DEFAULT DOES NOT MOVE. Only a surface that accumulates
 * asks for it; a surface whose count really does describe one fetched page keeps
 * {@link PAGE_SCOPED_SUFFIX} and reads exactly as it did.
 */
export const ACCUMULATED_SUFFIX = "loaded so far";

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
 * The service's `total`, or `undefined` when this render may not state it.
 *
 * VALIDATED RATHER THAN TRUSTED, and shared by everything that would state it,
 * which is the whole reason it is a function rather than a line inside the count
 * line. A non-integer, a negative, or a count BELOW the rows already on screen is
 * a service disagreeing with itself; the safe direction is the claim a render can
 * back up on its own. `total < count` is impossible for a count and a page taken
 * under one predicate, but they are two statements, so a concurrent insert or
 * delete between them is the ordinary case — only the direction that would
 * UNDERSTATE what the operator can see is refused.
 *
 * ZERO ROWS REFUSE EVERY TOTAL. A `total` above an empty page is the same
 * self-contradiction from the other side, and nothing may render it: not the
 * count line, not the page count.
 */
function statedTotal(count: number, total: number | undefined): number | undefined {
	if (count <= 0) return undefined;
	if (total === undefined || !Number.isSafeInteger(total) || total < count) return undefined;
	return total;
}

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
 *    level that deliberately WITHHOLDS one because the count it holds describes
 *    a different set of rows than the page does — a level that narrowed the
 *    fetched page itself, or one whose filter the service could not be asked to
 *    apply (products' "Low stock only" with no readable threshold: the service
 *    counted every product, so passing that number would caption the rows on
 *    screen as though the filter had run).
 *
 * `total` IS VALIDATED RATHER THAN TRUSTED, through {@link statedTotal} — which
 * is shared with the page count beneath this line precisely so that a figure one
 * of them refuses cannot reappear in the other.
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
	opts: { complete: boolean; total?: number; scopeSuffix?: string },
): string | undefined {
	// ZERO ROWS RENDER NO COUNT — `total` present or not. The alternative,
	// "17 orders" sitting immediately above "No orders yet" or "Nothing on this
	// page", is the screen contradicting itself in two adjacent blocks.
	if (count <= 0) return undefined;
	const stated = statedTotal(count, opts.total);
	const n = stated ?? count;
	const word = COUNT_PLURALS.select(n) === "one" ? noun.one : noun.other;
	const formatted = COUNT_NUMERALS.format(n);
	return stated !== undefined || opts.complete
		? `${formatted} ${word}`
		: `${formatted} ${word} ${opts.scopeSuffix ?? PAGE_SCOPED_SUFFIX}`;
}

/** The pager's two controls, authored here for the same reason `Load more` is:
 *  two React lists render them, and a label spelled per screen is the drift this
 *  package exists to prevent. */
export const PREVIOUS_PAGE_LABEL = "Previous";
export const NEXT_PAGE_LABEL = "Next";

/** The pager's own accessible name — it is a second navigation region on a
 *  screen that already has the admin's, so it has to say which one it is. */
export const PAGER_LABEL = "Pages";

/** An EN DASH joins the two ends of a page range — deliberately NOT the em dash
 *  {@link ABSENT} reserves for a missing value, because the position line is the
 *  one place that can carry both at once and `Pages 2—3 of —` would spell a
 *  range and an absence with the same glyph. */
const PAGE_RANGE_DASH = "\u2013";

/**
 * WHY A PAGER CONTROL IS DIMMED, in the three cases it can be, and what `Next`
 * warns before it is pressed.
 *
 * A control the operator cannot use and cannot see a reason for is the same
 * defect as a zero state with no words. Two of the three are self-evident once
 * said ("first page", "last page"); the third is not evident at all and is the
 * one this console had to decide.
 *
 * IT STATES IGNORANCE, NEVER PROVENANCE. The earlier wording said the page "was
 * opened from a link", and that is a claim about how the operator got here which
 * this tier cannot make: the same state is produced by a reload, a bookmark, a
 * traversal that outlived its entry's stored stack, and a host that re-mounted
 * the screen. All the screen knows is that it holds no record of the page before
 * this one, so that — and only that — is what it says. Same doctrine as the
 * refusal notices: name the fact, never the cause.
 *
 * AND `Next` NAMES ITS COST while it still has one. Pressing it with several
 * pages accumulated shows the next page ALONE, so the scan the operator built is
 * released; a control that quietly discards gathered work is the defect, and one
 * sentence in front of the click is the cheapest possible fix.
 */
export const PREVIOUS_AT_START_TITLE = "This is the first page.";
export const NEXT_AT_END_TITLE = "There is no page after this one.";
export const PREVIOUS_UNWALKED_TITLE = "The page before this one is not known here.";
export const NEXT_RELEASES_SCAN_TITLE =
	"Shows the next page on its own — the pages loaded above are released.";

/**
 * HOW MANY PAGES THERE ARE — derived, never fetched.
 *
 * THE WHOLE POINT: both halves are already on the wire. The service counts the
 * filtered set alongside the page it returns (`total`), and the plugin sends the
 * keyset limit it paged by (`vocabulary.pageLimit`), so the page count is
 * arithmetic over two values the render is already holding. A second query for
 * it would be a request bought with nothing.
 *
 * IT IS FED THE FIGURE THE COUNT LINE ACTUALLY STATED — `listOutcome`'s
 * `statedTotal`, not a raw payload number — and validates it again through the
 * same {@link statedTotal} gate. That is what keeps the two lines SOURCED from
 * one decision: a total the caption withheld cannot reappear as a page count
 * underneath it. It is not a proof that no two numbers on this screen can ever
 * read oddly together — the count and the page are still two statements taken at
 * two moments, and a write between them moves the boundary — but the DERIVATION
 * is single, so a disagreement can only come from the store changing, never from
 * the two lines having made up their minds separately. An absent, contradictory
 * or below-the-rows total yields `undefined`, which renders as an em dash, never
 * as `1` and never as `0`.
 *
 * WHERE THE REST OF THE PAGER LIVES: the client-side stack and the view it
 * derives are `PageTrail` and `pagerView` in `@otta-sh/admin-react`'s
 * `accumulate.ts`; the markup is `PagerButton` in its `ui.tsx`. This module owns
 * the words and the arithmetic and nothing else.
 *
 * A PAGE SIZE MUST BE A WHOLE POSITIVE NUMBER. Anything else describes no
 * paging at all, and dividing by it would invent a figure out of a malformed
 * one.
 *
 * IT IS AN APPROXIMATION UNDER CONCURRENCY, exactly as the count line is: the
 * count and the page were taken at two moments, and rows inserted between them
 * move the boundary. That is the same accuracy the operator already reads on
 * the line above; it is not a new claim.
 */
export function pageCount(
	rows: number,
	opts: { total?: number; pageSize?: number },
): number | undefined {
	const total = statedTotal(rows, opts.total);
	if (total === undefined) return undefined;
	const size = opts.pageSize;
	if (size === undefined || !Number.isSafeInteger(size) || size <= 0) return undefined;
	return Math.ceil(total / size);
}

/**
 * `Page 2 of 6` · `Pages 2–3 of 6` — and what it says when a half is unknown.
 *
 * IT DESCRIBES A WINDOW, NOT A POINT, and `span` is why. A list that
 * ACCUMULATES has more than one page on screen at once, and captioning fifty
 * rows drawn from two requests "Page 2 of 6" states only where the window ENDS —
 * an operator reading the top of that list is looking at page 1 under a line
 * that says 2. So a span above one is rendered as the range it is. The start is
 * derived rather than tracked: every page added to the window advances the
 * position by exactly one, so `index − span + 1` is the page the window opens
 * on, whatever mixture of steps built it.
 *
 * BOTH HALVES CAN BE ABSENT, INDEPENDENTLY, and each renders {@link ABSENT}:
 *
 *  - **M unknown** — the service sent no `total`, or sent one this render
 *    refuses. `Page 3 of —`. NEVER "of 1": that would state the operator is
 *    looking at the whole set at the exact moment nothing knows how big it is,
 *    and never "of 0", which is the absent-rendered-as-zero failure this
 *    console forbids everywhere else.
 *  - **N unknown** — nothing here holds a record of the pages before this one,
 *    so there is no walk to count. `Page — of 6`. The list still knows the size
 *    of the collection; it does not know where in it the operator is standing,
 *    and the dash is that fact rather than a hidden one. The noun still follows
 *    the span — `Pages — of 6` for a window of several — because how many pages
 *    are on screen is known even when their numbers are not.
 *
 * NEITHER KNOWN RENDERS NOTHING. "Page — of —" is a line that occupies space to
 * say it has nothing to say.
 *
 * AND M IS REFUSED WHEN IT FALLS BELOW N, the same rule {@link statedTotal}
 * applies one level down: the two figures come from statements taken at
 * different moments, so a concurrent delete can shrink the derived count below
 * the page the operator actually walked to. `Page 7 of 6` is a contradiction on
 * screen; a dash is an absence.
 */
export function pagePositionLine(opts: {
	index?: number;
	pages?: number;
	/** How many pages are on screen at once. Absent or 1 is the ordinary single
	 *  page; above that the line states the range. */
	span?: number;
}): string | undefined {
	const { index, pages } = opts;
	if (index === undefined && pages === undefined) return undefined;
	const span =
		opts.span !== undefined && Number.isSafeInteger(opts.span) && opts.span > 1 ? opts.span : 1;
	const usablePages =
		pages !== undefined && Number.isSafeInteger(pages) && pages > 0 && (index ?? 0) <= pages
			? pages
			: undefined;
	const m = usablePages === undefined ? ABSENT : COUNT_NUMERALS.format(usablePages);
	if (span === 1) {
		return `Page ${index === undefined ? ABSENT : COUNT_NUMERALS.format(index)} of ${m}`;
	}
	if (index === undefined) return `Pages ${ABSENT} of ${m}`;
	const start = COUNT_NUMERALS.format(Math.max(1, index - span + 1));
	return `Pages ${start}${PAGE_RANGE_DASH}${COUNT_NUMERALS.format(index)} of ${m}`;
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
 * clear, and this state must not invent a control of its own. That is unchanged
 * by the React pager below it — `Previous` is a control the SCREEN already
 * offers, standing where it always stands and reachable from any page; it is not
 * an affordance this zero state fabricated, and the Block Kit surface, which has
 * no pager, still renders exactly these words with nothing beside them.
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
/**
 * THE FIGURE THE COUNT LINE ACTUALLY USED, carried out so nothing downstream has
 * to re-derive it.
 *
 * IT IS ON EVERY VARIANT, `undefined` INCLUDED, and that is the point. The page
 * count beneath the list is the second thing on screen that would state a
 * `total`, and re-validating the caller's raw one there would be a SECOND
 * decision about the same number — which is exactly how "25 orders on this page"
 * ends up sitting above "Page 2 of 6". A caller feeds this value to
 * {@link pageCount} instead of the raw one, so a total this ladder withheld —
 * because the page was narrowed after the fetch, because the service contradicted
 * itself, because the page is empty — cannot reappear one line down.
 */
interface StatedTotal {
	readonly statedTotal: number | undefined;
}

export type ListOutcome =
	| ({
			readonly kind: "rows";
			readonly countLine: string | undefined;
			readonly emptyText: string;
	  } & StatedTotal)
	| ({
			readonly kind: "scan";
			readonly countLine: undefined;
			readonly scanNote: string;
	  } & StatedTotal)
	| ({
			readonly kind: "empty";
			readonly countLine: undefined;
			readonly title: string;
			readonly description: string;
			readonly offer: ZeroStateOffer;
			readonly emptyText: string;
	  } & StatedTotal);

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
	/** What qualifies a count the render cannot claim as the whole set. Absent ⇒
	 *  {@link PAGE_SCOPED_SUFFIX}; a list that accumulates passes
	 *  {@link ACCUMULATED_SUFFIX} instead, because its rows outlive the page they
	 *  arrived on. */
	readonly scopeSuffix?: string;
	/**
	 * WHAT `count` (and any `total`) DESCRIBE — a REQUIRED discriminant, not an
	 * opt-in, so a caller that narrows a page after fetching it cannot forget to
	 * say so and quietly inherit the larger, whole-set-capable default.
	 *
	 *  - `"service-filtered"` — every filter that produced `count` (and, when
	 *    present, `total`) is a predicate the SERVICE applied to its query. The
	 *    fetched page and the filtered set are the same collection, so
	 *    `firstPage && !hasNext` really does mean the counted set is complete,
	 *    and a `total` is honoured exactly as {@link rowCountLine} validates it.
	 *  - `"narrowed-after-fetch"` — `count` was produced by narrowing an
	 *    ALREADY-FETCHED page client-side. NO caller states this scope today:
	 *    products' "Low stock only" was the one that did, and it is a service
	 *    predicate now. The scope stays because the failure it prevents is one a
	 *    caller commits SILENTLY — a screen that filters rows in the browser and
	 *    says nothing gets the whole-set phrasing for free. Two things follow,
	 *    and both are ENFORCED here rather than left to the caller to get right:
	 *      1. `firstPage && !hasNext` is the FETCH being complete, not the
	 *         narrowed set — the moment a query happens to fit on one page, or a
	 *         scan exhausts every page, that would otherwise read as "the
	 *         counted set is complete" and drop the qualifier off a count that
	 *         has only ever described rows on screen. `complete` never goes true
	 *         in this scope.
	 *      2. A `total`, however it arrives, is NOT honoured: `listOutcome`
	 *         drops it before it reaches {@link rowCountLine}. A caller whose
	 *         narrowing did not actually apply to the page it is rendering must
	 *         report `"service-filtered"` for that page — passing
	 *         `"narrowed-after-fetch"` with a total present
	 *         is exactly the caller error this refusal exists to survive, not a
	 *         state this helper trusts a caller to avoid on its own.
	 */
	readonly countScope: "service-filtered" | "narrowed-after-fetch";
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
	const narrowedAfterFetch = opts.countScope === "narrowed-after-fetch";
	// THE ONE PLACE THE TOTAL IS DECIDED. Everything below reads this, including
	// what is handed back to the caller for the page count — see {@link
	// StatedTotal}.
	const stated = narrowedAfterFetch ? undefined : statedTotal(opts.count, opts.total);
	const countLine = rowCountLine(opts.count, opts.noun, {
		complete: opts.firstPage && !opts.hasNext && !narrowedAfterFetch,
		// REFUSED, NOT MERELY UNCLAIMED: a `total` is dropped here whenever the
		// scope says the page was narrowed after the fetch, even if the caller
		// passed one — see `countScope`'s doc. This is what survives a caller
		// mislabelling a page `narrowed-after-fetch` while a real `total` is
		// present (a `filterUnavailable` page that forwards the service's own
		// count): the mislabel would still be a bug, but it can no longer
		// resurrect the whole-set phrasing this scope exists to withhold.
		...(stated !== undefined ? { total: stated } : {}),
		...(opts.scopeSuffix !== undefined ? { scopeSuffix: opts.scopeSuffix } : {}),
	});
	if (opts.count > 0) {
		return { kind: "rows", countLine, emptyText: opts.noMatch.emptyText, statedTotal: stated };
	}
	if (opts.hasNext) {
		const lead = opts.filtered ? opts.noMatch.emptyText : NOTHING_ON_PAGE;
		return {
			kind: "scan",
			countLine: undefined,
			scanNote: opts.noMatch.scanNote ?? `${lead} ${SCAN_FURTHER}`,
			statedTotal: stated,
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
		statedTotal: stated,
	};
}
