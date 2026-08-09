/**
 * The React Orders list — the screen the whole migration exists for.
 *
 * WHAT IS DIFFERENT FROM THE BLOCK KIT SCREEN, and it is a short list on
 * purpose. INC-20 is a migration, not a redesign: the columns, the status
 * words, the timestamps, the counts, the empty-state copy and the Period filter
 * are the finished Block Kit behaviour, rendered by different code. What React
 * buys, and all it is spent on here:
 *
 *  - **Row click** (`ADDENDUM §H`), absent from stock Block Kit at every version
 *    through 0.31.1 and the complaint this effort opened on.
 *  - **The copy button §1.3 wants** — the row shows a git-style short prefix and
 *    the button copies the FULL id. On Block Kit a table cell is a scalar with no
 *    per-cell affordance; that was the accepted degradation and this is it
 *    being repaid.
 *  - **No picker.** `Open order` is deleted, and with it the `ComboboxList`
 *    duplicate-key React error, which is picker-only.
 *  - **No round trip per interaction.** Opening an order is a state change, not
 *    a POST that replaces the whole block tree and loses the scroll position.
 *
 * WHAT IS DELIBERATELY NOT DIFFERENT:
 *
 *  - **Sorting stays OFF** (§1.2). Not because React cannot sort — it trivially
 *    can — but because sort is not wired through `ListLevelDef.fetchPage` into
 *    the list ports, so a client-side sort would order the LOADED PAGE and
 *    silently present it as the order of the list. That is the same defect
 *    §1.2 rejects on Block Kit wearing better clothes.
 *  - **Filtering stays SERVER-SIDE**, for the same reason. ADR-0014 lists
 *    "client-side filter at zero network calls" among React's wins, and it is
 *    one — for a fully-loaded collection. This list is keyset-paged at 25, so a
 *    client-side filter would search the rows in hand and answer "no orders
 *    match" for an order that exists on page 2. The filter posts, exactly as it
 *    does today.
 */
import {
	ACCUMULATED_SUFFIX,
	APPLY_FILTERS_LABEL,
	CLEAR_FILTERS_LABEL,
	LOAD_MORE_LABEL,
	ORDERS_EMPTY,
	ORDERS_LIST_INTRO,
	ORDERS_LOAD_MORE_FAILED_TITLE,
	ORDERS_NOUN,
	ORDERS_NO_MATCH,
	ORDERS_SEARCH_LABEL,
	ORDERS_STALE_CLEARED_NOTE,
	RETRYING_LABEL,
	RETRY_LABEL,
	buyerReferenceText,
	formatAmount,
	formatTimestamp,
	listOutcome,
	orderStateCell,
	shortIdFixed,
	shortIdsFor,
} from "@otta-sh/admin-presentation";
import * as React from "react";
import {
	CURSOR_RESET_DESCRIPTION,
	CURSOR_RESET_TITLE,
	PAGING_STOPPED_DESCRIPTION,
	PAGING_STOPPED_TITLE,
	continuationCursor,
	mergeById,
	seedCursor,
	type PendingCursor,
} from "../accumulate.js";
import {
	fetchOrders,
	isFailure,
	type OrderSummary,
	type OrdersFilter,
	type Vocabulary,
} from "../console-api.js";
import {
	Button,
	CopyIdButton,
	EmptyState,
	EndHeader,
	Field,
	Group,
	Notice,
	StatusPill,
	Table,
	buttonStyle,
	endCellStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";

/**
 * The one order state that earns a ring (D1).
 *
 * BADGE THE EXCEPTION, LEAVE THE REST BARE. `failed` is the only status an
 * operator has to act on out of a column of forty, so it is the only one drawn
 * as anything other than the word itself. Pilling `paid` and `delivered` too
 * would be the symmetric-looking change that destroys the whole point: a mark on
 * every row marks nothing. The phrase inside the pill is still
 * `orderStateCell`'s, so the words cannot drift from the bare cells beside it.
 */
const PILLED_ORDER_STATE = "failed";

/** The identity cell's link, and the only tab stop in its row.
 *
 *  Weight and a muted underline at a 2px offset are what make a link that
 *  inherits its colour (the sheet bans fixed foregrounds) still read as a way in
 *  rather than as the static text beside it. The negative margin pays back the
 *  padding, so the hit area is larger than the four glyphs without the cell
 *  growing around it. */
const orderLinkStyle: React.CSSProperties = {
	color: "inherit",
	fontFamily: "ui-monospace, monospace",
	fontWeight: 600,
	// F16 recedes the prefix; F18 makes what is left legible as a link.
	opacity: 0.72,
	// THE REST STATE ONLY. The muted colour, the offset, and going solid on hover
	// and on keyboard focus belong to `.otta-link`, which both lists now share: a
	// pseudo-class cannot be written as a style object, and an inline decoration
	// colour here would outrank every one of that rule's triggers.
	textDecorationLine: "underline",
	padding: "2px 4px",
	margin: "-2px -4px",
};

/**
 * THE FIVE-OUTCOME LADDER IS NOT REIMPLEMENTED HERE (INC-20 review).
 *
 * The first cut of this file had two branches — "no rows and a filter is on" and
 * "no rows" — and hard-coded the Block Kit screen's copy beside them. That is
 * three defects in one shape, and a reviewer found all three:
 *
 *  1. A page-2 miss claimed **"No orders yet"**, a whole-collection claim this
 *     render has not earned. Page 1 had rows.
 *  2. Zero rows with a cursor still behind them rendered an empty state, which
 *     sat on top of `Load more` and **stranded the operator mid-scan** on a page
 *     that is not the end of anything. The Block Kit tier hit the same wall
 *     through a different mechanism (its renderer short-circuits a zero-row
 *     table carrying `empty_text` and takes the button with it) and answered it
 *     with the scan note this now renders.
 *  3. The count line used `String(count)` and an `s`, making it the one rendered
 *     value in this console a threaded locale would not reach.
 *
 * All three are what happens when a decision argued this carefully is written
 * twice. `listOutcome` and the copy constants come from
 * `@otta-sh/admin-presentation`; both surfaces make the SAME call with the same
 * inputs and differ only in how they draw the answer.
 */

/** One string per authored filter that is not at its default — the same parts
 *  the Block Kit panel counts as `(N active)` and summarises beneath itself. */
export function activeFilterParts(filter: OrdersFilter, periodLabel: string): string[] {
	const parts: string[] = [];
	if (filter.status !== undefined) parts.push(`status: ${filter.status}`);
	if (filter.period === "custom") {
		if (filter.from !== undefined) parts.push(`from: ${filter.from}`);
		if (filter.to !== undefined) parts.push(`to: ${filter.to}`);
	} else if (filter.period !== undefined) {
		parts.push(`period: ${periodLabel}`);
	}
	if (filter.search !== undefined) parts.push(`search: ${filter.search}`);
	return parts;
}

/** Trim a submitted form down to the fields that are NOT at their default —
 *  which is what makes "active filters" countable and what the plugin's
 *  `readFilter` expects to receive. */
function normalize(draft: OrdersFilter, statusAny: string): OrdersFilter {
	const custom = draft.period === "custom";
	return {
		...(draft.status !== undefined && draft.status !== statusAny && draft.status.length > 0
			? { status: draft.status }
			: {}),
		...(draft.period !== undefined && draft.period !== statusAny ? { period: draft.period } : {}),
		...(custom && draft.from !== undefined && draft.from.length > 0 ? { from: draft.from } : {}),
		...(custom && draft.to !== undefined && draft.to.length > 0 ? { to: draft.to } : {}),
		...(draft.search !== undefined && draft.search.length > 0 ? { search: draft.search } : {}),
	};
}

/** One response, before it is merged into what is already on screen. */
export interface OrdersResponse {
	readonly orders: readonly OrderSummary[];
	readonly nextCursor: string | null;
	/** INC-23's exact filtered-set count, when the service reports one. */
	readonly total: number | undefined;
	readonly vocabulary: Vocabulary;
}

interface LoadedPage extends OrdersResponse {
	/** Whether the rendered rows START at the collection's first page — which,
	 *  now that pages accumulate, stays TRUE across a `Load more`: the rows above
	 *  are still there. It is what lets the count claim the whole set on the last
	 *  page of a scan that began at the first. */
	readonly firstPage: boolean;
	/** How many responses these rows were merged from. `1` is the ordinary
	 *  render; anything above it is what makes "on this page" the wrong words. */
	readonly pages: number;
}

/**
 * WHAT A SUCCESSFUL RESPONSE DOES TO THE ROWS ALREADY ON SCREEN (F24).
 *
 * The defect this replaces was one line: the response was ASSIGNED into list
 * state, so a successful `Load more` threw away the page the operator was
 * reading and showed them page two alone. Nothing had to fail for that.
 *
 * A CONTINUATION EXTENDS; EVERYTHING ELSE RESETS. `continuation` is "this
 * request carried a cursor", which is exactly the request `Load more` (and a
 * Retry of it) issues. A filter change clears the cursor before re-fetching, so
 * it arrives here as a reset and the previous filter's rows go — and a first
 * mount, including one deep-linked to a filtered address, is the same reset.
 * Getting that backwards shows either the old filter's rows under the new
 * filter, or page two alone with everything above it dropped.
 *
 * THE CURSOR, THE TOTAL AND THE VOCABULARY TAKE THE NEW PAGE'S VALUES; the rows
 * merge by id (see {@link mergeById}) and `firstPage` is inherited, because a
 * scan that began at the first page still starts there after its second page
 * lands.
 */
export function nextPage(
	current: LoadedPage | null,
	incoming: OrdersResponse,
	continuation: boolean,
): LoadedPage {
	if (!continuation) return { ...incoming, firstPage: true, pages: 1 };
	// A continuation with nothing to continue is not reachable from this screen
	// — the cursor is cleared whenever the page state is — but it is still a
	// render that does NOT start at the first page, and says so.
	if (current === null) return { ...incoming, firstPage: false, pages: 1 };
	return {
		...incoming,
		orders: mergeById(current.orders, incoming.orders, (order) => order.id),
		firstPage: current.firstPage,
		pages: current.pages + 1,
	};
}

/** A load that came back a refusal. `continuation` records WHICH request failed
 *  — a first page, or a page behind one that already succeeded — because that
 *  is what decides whether the rows on screen are disproved by the failure or
 *  untouched by it. */
export interface OrdersFailure {
	readonly title: string;
	readonly description: string;
	readonly continuation: boolean;
}

/**
 * Drop the ANSWER from a loaded page while keeping what the page is not.
 *
 * The rows, the cursor and the exact count are claims about a response this
 * render can no longer vouch for, and they go together — a count without its
 * rows is the same lie in fewer words. The VOCABULARY is not part of the
 * answer: it is what the filter controls are built from, and clearing it would
 * leave the operator standing in front of a Period menu with no options, which
 * is precisely the cold-failure defect this screen is fixing (F3).
 *
 * Nothing here is a render guard. The screen is cleared in STATE, so no branch
 * can accidentally read a row that is no longer true.
 */
export function clearAnswer(page: LoadedPage | null): LoadedPage | null {
	return page === null ? null : { ...page, orders: [], nextCursor: null, total: undefined };
}

/**
 * What a failed response leaves of the page.
 *
 * THE PARTIAL CASE IS THE ONE THE OBVIOUS IMPLEMENTATION DESTROYS. "On failure,
 * clear the page" is right for cold and for stale and wrong here: a page that
 * failed BEHIND one that succeeded disproves nothing already on screen, so
 * every accumulated row, the exact count and the cursor stand untouched.
 *
 * It is a function rather than two lines inside the effect so that the branch
 * is a value a test can read — the same reason `clearAnswer` is one.
 */
export function pageAfterFailure(
	page: LoadedPage | null,
	continuation: boolean,
): LoadedPage | null {
	return continuation ? page : clearAnswer(page);
}

/** What a failure leaves on the screen, and what the card over it says. */
export interface OrdersFailureCard {
	readonly kind: "cold" | "stale" | "partial";
	readonly title: string;
	readonly description: string;
	/** The rows, the count line, the zero states and `Load more`. */
	readonly answerVisible: boolean;
	/** The filter bar and the filter summary. */
	readonly filtersVisible: boolean;
	/** Rendered where `Load more` was, rather than above the list. */
	readonly inline: boolean;
	/** Focus was inside a row that no longer exists. */
	readonly focusRetry: boolean;
}

/**
 * THREE FAILURES, NOT ONE (F1).
 *
 * `everLoaded` is "a page has landed at least once", NOT "there are rows right
 * now" — by the time this is read the rows are already gone, so counting them
 * would report every stale failure as a cold one and take the filter bar with
 * it.
 *
 *  - **Cold.** Nothing has ever loaded, so there is nothing to filter with and
 *    nothing to keep: the error card alone.
 *  - **Stale.** A first page failed under rows that are now cleared. The card
 *    carries the server's own words plus the sentence that says the rows went
 *    and why; the filter bar stays, because the operator's typed filters are
 *    input rather than answer.
 *  - **Partial.** A page BEHIND a successful one failed. Every accumulated row
 *    and the count stand, and the server's whole-collection title is dropped —
 *    the rows above disprove it. What failed was the next page, and the card
 *    says so from where `Load more` was.
 */
export function ordersFailureCard(failure: OrdersFailure, everLoaded: boolean): OrdersFailureCard {
	if (!everLoaded) {
		return {
			kind: "cold",
			title: failure.title,
			description: failure.description,
			answerVisible: false,
			filtersVisible: false,
			inline: false,
			focusRetry: false,
		};
	}
	if (failure.continuation) {
		return {
			kind: "partial",
			title: ORDERS_LOAD_MORE_FAILED_TITLE,
			description: failure.description,
			answerVisible: true,
			filtersVisible: true,
			inline: true,
			focusRetry: false,
		};
	}
	return {
		kind: "stale",
		title: failure.title,
		description:
			failure.description.length > 0
				? `${failure.description} ${ORDERS_STALE_CLEARED_NOTE}`
				: ORDERS_STALE_CLEARED_NOTE,
		answerVisible: false,
		filtersVisible: true,
		inline: false,
		focusRetry: true,
	};
}

/** Everything the screen draws AROUND the answer, decided in one place. */
export interface OrdersChrome {
	/** `null` when there is no failure to report. */
	readonly card: OrdersFailureCard | null;
	/** The rows, the count line, the zero states and `Load more`. */
	readonly answerVisible: boolean;
	/** The filter bar and the filter summary. */
	readonly filtersVisible: boolean;
	/** The Retry on the card, in whichever of its two states applies. */
	readonly retry: {
		readonly label: string;
		readonly disabled: boolean;
		readonly busy: boolean;
		readonly autoFocus: boolean;
	};
}

/**
 * ONE GUARD PER THING THE SCREEN CLAIMS, and both are the failure card's to
 * withdraw. The bug F1 names is that the table rendered under
 * `outcome.kind === "rows"` while its two sibling branches also checked
 * `failure === null`, so a failure the count and the notice both acknowledged
 * left the rows standing.
 *
 * NO FAILURE MEANS NOTHING IS WITHDRAWN — including on the very first fetch,
 * before any page has landed. A load in progress is not a failure: hiding the
 * filter bar until the first response arrives would take it off the screen on
 * every mount and drop it back in mid-render. Only a COLD FAILURE removes the
 * bar (F3), and only because the Period menu it would draw has no options.
 *
 * `retrying` IS THE RETRY'S OWN CLICK, never the screen-wide load flag. The
 * filter bar stays interactive in the stale and partial states, so an "Apply
 * filters" the operator pressed would otherwise make the untouched Retry beside
 * it read "Retrying…", disable, and claim `aria-busy` for a request nobody
 * issued.
 */
export function ordersChrome({
	failure,
	everLoaded,
	retrying,
}: {
	readonly failure: OrdersFailure | null;
	readonly everLoaded: boolean;
	readonly retrying: boolean;
}): OrdersChrome {
	const card = failure === null ? null : ordersFailureCard(failure, everLoaded);
	return {
		card,
		answerVisible: card === null || card.answerVisible,
		filtersVisible: card === null || card.filtersVisible,
		retry: {
			label: retrying ? RETRYING_LABEL : RETRY_LABEL,
			disabled: retrying,
			busy: retrying,
			autoFocus: card?.focusRetry === true,
		},
	};
}

export function OrdersList({
	onOpen,
	initialFilter = {},
	initialCursor,
	onFilterChange,
	onCursorChange,
}: {
	onOpen: (orderId: string) => void;
	/** The filter the address bar arrived with (F22). BOTH the applied filter and
	 *  the draft are seeded from it, so a shared link lands filtered AND the panel
	 *  shows why, rather than reading as an unfiltered list that mysteriously
	 *  holds four rows. */
	initialFilter?: OrdersFilter;
	/**
	 * The page the address bar arrived with — an opaque service token, moved
	 * verbatim and never inspected.
	 *
	 * IT IS THE PAGE, NOT THE SCAN. A reload of a paged address restores the page
	 * the operator was on, not the stack of pages they scrolled through to reach
	 * it: the address carries one cursor, and a link that replayed N requests
	 * would be a different feature (and a slower one). The same applies to a
	 * traversal — Back onto an earlier page's entry re-fetches that page, not the
	 * accumulation the operator had built when they left it.
	 *
	 * WHAT THE COUNT LINE THEN SAYS depends on the service, not on this prop, and
	 * the common production answer is NOT the page-scoped hedge. `firstPage` is
	 * false on a deep-linked page, so a render with no `total` says "N orders on
	 * this page" — but the service does send `total` (the exact size of the
	 * filtered set, counted alongside the page), and with one present the line
	 * states that whole-set figure on every page, which is both correct and
	 * page-independent. The hedge is the fallback for a service that omits the
	 * field, not the normal case.
	 */
	initialCursor?: string;
	/** Announced whenever the applied filter changes, for the screen to write to
	 *  the URL. The list never touches history itself: one writer. */
	onFilterChange?: (filter: OrdersFilter) => void;
	/**
	 * Announced whenever the page the list is showing changes — a cursor the
	 * operator paged to, or `undefined` for "back at page one". Same contract as
	 * {@link onFilterChange}: the list states what happened, the screen decides
	 * what that does to the history stack.
	 *
	 * ITS IDENTITY MUST BE STABLE ACROSS RENDERS. It is a dependency of the fetch
	 * effect (so the effect cannot close over a stale one), which means a caller
	 * passing a fresh arrow on every render would re-run the effect on every
	 * render — a refetch loop. The screens wrap it in `useCallback`.
	 */
	onCursorChange?: (cursor: string | undefined) => void;
}): React.ReactElement {
	const [applied, setApplied] = React.useState<OrdersFilter>(initialFilter);
	const [draft, setDraft] = React.useState<OrdersFilter>(initialFilter);
	const [page, setPage] = React.useState<LoadedPage | null>(null);
	const [failure, setFailure] = React.useState<OrdersFailure | null>(null);
	const [busy, setBusy] = React.useState(true);
	// The Retry's OWN in-flight state, separate from `busy` because `busy` is the
	// whole screen's: see `ordersChrome`.
	const [retrying, setRetrying] = React.useState(false);
	// Bumped by "Apply filters" and by Retry, so a re-fetch is an effect
	// dependency rather than a call scattered through event handlers. RETRY IS THE
	// WHOLE OF THE MECHANISM: same filter, same cursor, one integer.
	//
	// `Load more` DOES NOT BUMP IT, and does not need to: the cursor it sets is a
	// fresh object on every click, so the effect re-runs even when the service
	// hands back a cursor VALUE it has already used. Keying the re-fetch on that
	// value alone is what would make such a click a silent no-op.
	const [generation, setGeneration] = React.useState(0);
	/** SEEDED FROM THE ADDRESS, bound to the very filter object that seeded
	 *  `applied` above — see {@link seedCursor}. Binding it to a copy would make
	 *  every deep link fail `continuationCursor`'s identity test and degrade,
	 *  silently, into a first-page reload. */
	const [cursor, setCursor] = React.useState<PendingCursor<OrdersFilter> | null>(() =>
		seedCursor(initialFilter, initialCursor),
	);
	/** The address named a page that would not open, and this render is the first
	 *  page of its filters instead — the SEEDED path only. See the effect. */
	const [cursorReset, setCursorReset] = React.useState(false);
	/**
	 * A `Load more` was refused mid-scan, so paging is over until the operator
	 * starts a fresh one.
	 *
	 * IT WITHDRAWS THE CONTROL, NEVER THE CURSOR. Nulling `page.nextCursor` would
	 * be the obvious way to hide `Load more`, and it is the trap: `hasNext` going
	 * false flips the shared outcome to a COMPLETED scan, which drops the "loaded
	 * so far" hedge and states the accumulated rows as the whole set — a
	 * whole-collection claim made at the exact moment this render learned it cannot
	 * see the rest. The cursor is this render's evidence that more exists, and a
	 * refused attempt to follow it does not disprove that. So the evidence stays
	 * and only the offer is taken away.
	 */
	const [pagingStopped, setPagingStopped] = React.useState(false);
	/**
	 * Has any page landed on this mount? It is what tells the two refusals apart.
	 *
	 * A refused cursor is one condition with two costs. Before any page has landed
	 * it came from the ADDRESS — a deep link or a reload — and there is nothing to
	 * lose: page one of the link's filters is a complete answer, so the retry's
	 * rows are shown and the address is corrected. After a page has landed it came
	 * from a `Load more`, and the same treatment would throw away every page the
	 * operator has gathered to show them the first one again. Same refusal,
	 * opposite response.
	 *
	 * A REF because the fetch effect does not depend on `page` and would otherwise
	 * read a render-old value — and this is read when a response arrives, which may
	 * be several renders later.
	 */
	const landed = React.useRef(false);
	/**
	 * ONE CLEARED CURSOR THAT MUST NOT RE-FETCH.
	 *
	 * The cursor is an effect dependency, so clearing it normally means "go and ask
	 * again" — exactly right when a filter changes, exactly wrong after a refused
	 * page: that response already carried the answer, so asking again would issue a
	 * second identical request for nothing (and, mid-scan, would fetch rows this
	 * screen has just decided to discard). The cursor still has to go — a refused
	 * token left in state is one a later Retry would re-send — so the clear happens
	 * and the single fetch it would trigger is skipped.
	 *
	 * IT IS CONSUMED BY THE VERY NEXT RUN, WHICHEVER RUN THAT IS. Read and reset at
	 * the top of the effect before anything can return early, so the flag cannot
	 * outlive the run it was set for and suppress an unrelated fetch later; the
	 * `cursor === null` half is what makes it skip only the run the clear caused.
	 * A boolean that is merely usually consumed is a boolean that eventually eats
	 * somebody's page.
	 */
	const skipRefetchAfterReset = React.useRef(false);
	/** The reset notice's own region, focused when it appears — see the effect
	 *  below. */
	const resetRegion = React.useRef<HTMLDivElement | null>(null);

	React.useEffect(() => {
		const skip = skipRefetchAfterReset.current;
		skipRefetchAfterReset.current = false;
		// See {@link skipRefetchAfterReset}: this run exists only because a refused
		// page cleared the cursor, and its answer is already on screen.
		if (skip && cursor === null) return;
		let cancelled = false;
		// A CURSOR IS ONLY A CONTINUATION OF ITS OWN FILTER (see
		// `continuationCursor`): one belonging to a filter that has since been
		// replaced is not sent, and this request is the new filter's first page.
		const from = continuationCursor(cursor, applied);
		const continuation = from !== undefined;
		setBusy(true);
		void fetchOrders(applied, from).then((result) => {
			if (cancelled) return;
			setBusy(false);
			// Whatever the outcome, the click that asked for this is over.
			setRetrying(false);
			if (isFailure(result)) {
				/*
				 * A FAILURE NEVER RESETS THE PAGE, and the first cut had this wrong.
				 *
				 * It treated any refusal of a seeded cursor as "that token is no good",
				 * dropped the cursor and rewrote the address. But every failure reaches
				 * this tier in ONE shape — by design, since a console that had to tell
				 * transport from authorization from refusal would be a console with three
				 * empty states — so an expired session, a 500 and a dropped connection
				 * all looked like a bad token, and the address was rewritten for all of
				 * them, discarding the only record of where the operator was at exactly
				 * the moment a reload would have restored it.
				 *
				 * THE DISTINCTION IS MADE WHERE IT CAN BE SEEN: the plugin's admin client
				 * reads the service's own refusal code, performs the prescribed page-one
				 * recovery itself, and reports it as `cursorRejected` on a SUCCESSFUL
				 * payload (see the branch below). So a refused page arrives here as rows,
				 * and everything else arrives here — as a failure that leaves the cursor
				 * exactly where it was, in state and in the address.
				 */
				setFailure({ title: result.title, description: result.description, continuation });
				// A FIRST PAGE THAT FAILED DISPROVES WHAT IS ON SCREEN; a page behind
				// one that succeeded does not. Only the first case clears.
				setPage((current) => pageAfterFailure(current, continuation));
				return;
			}
			setFailure(null);
			/*
			 * THE PAGE THIS REQUEST ASKED FOR WAS REFUSED, AND THIS IS PAGE ONE.
			 *
			 * The service fails closed when a cursor disagrees with the filters beside
			 * it or will not decode, and its remedy is mechanical rather than an error:
			 * drop the token, re-issue page one with the same parameters. The plugin's
			 * client does exactly that and says so, so what arrives is a real first
			 * page plus the fact that the operator did not get the one they named.
			 *
			 * WHAT THAT COSTS DEPENDS ENTIRELY ON WHERE THE CURSOR CAME FROM, which is
			 * why this branches (see {@link landed}):
			 *
			 *  - FROM THE ADDRESS, before anything landed — a deep link or a reload.
			 *    Nothing is lost by showing page one of that link's filters, which is
			 *    a complete answer; the rows below are used, the address is corrected
			 *    to match them, and the notice explains the difference.
			 *  - FROM A `Load more`, with pages already gathered. Showing page one here
			 *    would DESTROY the scan to re-show the rows the operator read twenty
			 *    rows ago. So the retry's rows are discarded unmerged, the accumulation
			 *    stands untouched, and the only thing withdrawn is the offer to
			 *    continue. The address drops the dead page either way — it names
			 *    somewhere this screen can no longer go.
			 */
			const rejected = result.cursorRejected === true;
			const midScan = rejected && landed.current;
			if (rejected) {
				skipRefetchAfterReset.current = true;
				setCursor(null);
				onCursorChange?.(undefined);
				if (midScan) setPagingStopped(true);
				else setCursorReset(true);
			}
			if (midScan) {
				// THE ONE RESPONSE THIS SCREEN THROWS AWAY. Every row in it is real and
				// none of it belongs here: it answers a question (page one) nobody on
				// this screen asked, and merging it would reorder a scan around rows the
				// operator has already scrolled past.
				return;
			}
			landed.current = true;
			// F24: MERGE, NEVER ASSIGN. See `nextPage` — the functional form is
			// required, not stylistic, because the rows it merges into are the ones
			// in state at the moment the response lands.
			setPage((current) =>
				nextPage(
					current,
					{
						orders: result.orders,
						nextCursor: result.nextCursor,
						total: result.total,
						vocabulary: result.vocabulary,
					},
					// A REFUSED CURSOR MAKES THIS A RESET, whatever the request was: the
					// rows are page one's, so merging them onto an accumulation (or
					// inheriting `firstPage: false` from a continuation that never
					// happened) would caption a first page as the middle of a scan.
					continuation && !rejected,
				),
			);
		});
		return () => {
			cancelled = true;
		};
		// `onCursorChange` IS A DEPENDENCY because the effect calls it — closing over
		// a stale one would announce a page change to a screen that had moved on. It
		// is safe to depend on only because every caller keeps its identity stable
		// (the screens use `useCallback`); an unstable one would re-run this effect,
		// and therefore re-fetch, on every render.
	}, [applied, cursor, generation, onCursorChange]);

	/**
	 * THE RESET NOTICE HAS TO BE HEARD, not merely rendered.
	 *
	 * `Notice` is an `aria-live="polite"` region, and a live region that is
	 * INSERTED with its text already in place is the one case assistive technology
	 * is not required to announce — the region has to exist before its contents
	 * change for the change to be observed. Every other notice on this screen
	 * either follows a click the operator made (so they are looking at it) or, in
	 * the stale-failure case, hands focus to the region through the Retry it
	 * carries. This one appears unbidden, on arrival, with nothing to click, and
	 * explains why the screen is not showing what the link promised: the operator
	 * has to get it.
	 *
	 * SO FOCUS MOVES TO THE REGION, the same destination `Notice`'s own
	 * `handOffFocusTo` uses. It fires only on the transition into the reset state,
	 * which happens once and only just after a mount — never mid-interaction,
	 * because paging and applying filters both clear the flag.
	 */
	React.useEffect(() => {
		if (!cursorReset) return;
		const region = resetRegion.current?.firstElementChild;
		if (region instanceof HTMLElement) region.focus();
	}, [cursorReset]);

	const orders = page?.orders ?? [];
	// §1.3: computed over EXACTLY the array being rendered, so the prefix in a
	// row is unique among the rows the operator can see. `shortIdsFor` is total
	// and deterministic in the SET, so re-rendering cannot renumber the page.
	const shortIds = React.useMemo(() => shortIdsFor(orders.map((o) => o.id)), [orders]);
	const vocabulary = page?.vocabulary;
	const statusAny = vocabulary?.statusAny ?? "any";
	const periodLabel =
		vocabulary?.periods.find((p) => p.key === applied.period)?.label ?? "Any time";
	const parts = activeFilterParts(applied, periodLabel);
	const filtered = parts.length > 0;
	const hasNext = page?.nextCursor != null;

	// THE SHARED DECISION. Same function, same inputs, as the Block Kit screen's
	// `listResult` — so the count line, the wording, and which state renders at
	// all cannot disagree between the two Orders screens.
	//
	// THE MONEY HEADER IS A BARE `Total`, and the first cut's `Total (USD)` was
	// wrong twice over. It is a deviation from the screen being migrated, which
	// the acceptance forbids in as many words ("any deviation is a separate
	// PR"); and it cannot be right anyway on a list that may mix currencies,
	// where the header would state one and the rows below it would carry others.
	// `formatAmount` puts the currency in every cell, which is where a
	// heterogeneous column has to carry it.
	const outcome = listOutcome({
		count: orders.length,
		filtered,
		firstPage: page?.firstPage ?? true,
		hasNext,
		// EVERY FILTER ON THIS SCREEN IS A SERVICE PREDICATE (status, period,
		// search) — there is no Orders equivalent of products' "Low stock only",
		// so the fetched page and the filtered set are always the same
		// collection and `firstPage && !hasNext` may stand for "the counted set
		// is complete". `countScope` is required on every `listOutcome` call, so
		// a future narrowing here cannot omit stating it.
		countScope: "service-filtered",
		noun: ORDERS_NOUN,
		empty: ORDERS_EMPTY,
		noMatch: ORDERS_NO_MATCH,
		// F24. Once two responses are on screen at once, "25 orders on this page"
		// is the wrong sentence for 50 rows — they are what has been loaded so
		// far. The Block Kit tier still replaces rather than accumulates, so it
		// keeps the shared phrasing and the divergence is deliberate.
		...((page?.pages ?? 1) > 1 ? { scopeSuffix: ACCUMULATED_SUFFIX } : {}),
		// INC-23. The React list states the SAME exact figure the Block Kit list
		// states, because both hand it to the same `rowCountLine`. Threading it
		// here is the whole of what "honour total on the React side" costs, and
		// it is that cheap only because the count logic was already shared — had
		// it stayed on the Block Kit side, this screen would have gone on saying
		// "25 orders on this page" next to a sidebar entry saying "137 orders".
		...(page?.total !== undefined ? { total: page.total } : {}),
	});

	const apply = (next: OrdersFilter) => {
		setApplied(next);
		setDraft(next);
		setCursor(null);
		// THE RESET NOTICE IS ABOUT THE ARRIVAL, so it goes the moment the operator
		// asks for something themselves. Left standing it would explain a link that
		// no longer has anything to do with what is on screen.
		setCursorReset(false);
		// A fresh scan is exactly what the withdrawn control was waiting for.
		setPagingStopped(false);
		// BUSY IS THE CLICK'S, NOT THE EFFECT'S. Setting it only inside the effect
		// left one commit in which the applied filter had already moved and
		// `Load more` still rendered enabled — offering the previous page's cursor
		// under the new filter. The pairing is refused in `continuationCursor`
		// whatever happens here; this is what stops the control being offered at all.
		setBusy(true);
		setGeneration((n) => n + 1);
		// The cursor deliberately does NOT go with it: paging is where the operator
		// got to, not what the link describes, and a link that replays N pages is a
		// different feature.
		onFilterChange?.(next);
	};

	// EVERY GUARD ON THIS SCREEN, DECIDED ONCE — see `ordersChrome`. `everLoaded`
	// is "a page has landed", not "there are rows now": by the time this is read
	// the rows are already gone.
	const { card, answerVisible, filtersVisible, retry } = ordersChrome({
		failure,
		everLoaded: page !== null,
		retrying,
	});

	// THE FAILURE IS NOT CLEARED HERE. Clearing it on the click rather than on
	// the response would flash the stale answer back for the length of the
	// request — the exact defect being fixed. The response clears it.
	const retryAction = {
		...retry,
		onClick: () => {
			setRetrying(true);
			setGeneration((n) => n + 1);
		},
	};

	return (
		<div>
			<h1 style={{ fontSize: 24, fontWeight: 700, marginBlockEnd: 4 }}>Orders</h1>
			<p style={{ fontSize: 13, opacity: 0.75, marginBlockEnd: 16 }} data-testid="orders-intro">
				{outcome.countLine === undefined || !answerVisible
					? ORDERS_LIST_INTRO
					: `${outcome.countLine} · ${ORDERS_LIST_INTRO}`}
			</p>

			{card !== null && !card.inline && (
				<Notice
					variant="error"
					title={card.title}
					description={card.description}
					action={retryAction}
					testId="orders-failure"
				/>
			)}

			{/*
			  THE ADDRESS NAMED A PAGE THAT WOULD NOT OPEN, and this is the first
			  page of its filters instead. An ALERT rather than an error: there is a
			  working list underneath, and what the operator needs is the one
			  sentence saying they are not where the link they followed said they
			  would be. It is withdrawn with the answer, so it never sits over a cold
			  failure describing rows that are not there. The wrapper is what the
			  focus effect above reaches the live region through.
			*/}
			{cursorReset && answerVisible && (
				<div ref={resetRegion}>
					<Notice
						variant="alert"
						title={CURSOR_RESET_TITLE}
						description={CURSOR_RESET_DESCRIPTION}
						testId="orders-cursor-reset"
					/>
				</div>
			)}

			{filtersVisible && (
				<Group
					label={`Filters${parts.length > 0 ? ` (${String(parts.length)} active)` : ""}`}
					testId="orders-filters"
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
							gap: 12,
							alignItems: "end",
						}}
					>
						<Field label="Status">
							<select
								className="otta-focusable"
								data-testid="filter-status"
								style={inputStyle}
								value={draft.status ?? statusAny}
								onChange={(event) => setDraft({ ...draft, status: event.target.value })}
							>
								<option value={statusAny}>All statuses</option>
								{(vocabulary?.statuses ?? []).map((state) => (
									<option key={state} value={state}>
										{state}
									</option>
								))}
							</select>
						</Field>

						{draft.period === "custom" ? (
							<>
								<Field label="From">
									<input
										type="date"
										className="otta-focusable"
										data-testid="filter-from"
										style={inputStyle}
										value={draft.from ?? ""}
										onChange={(event) => setDraft({ ...draft, from: event.target.value })}
									/>
								</Field>
								<Field label="To">
									<input
										type="date"
										className="otta-focusable"
										data-testid="filter-to"
										style={inputStyle}
										value={draft.to ?? ""}
										onChange={(event) => setDraft({ ...draft, to: event.target.value })}
									/>
								</Field>
							</>
						) : (
							<Field label="Period">
								<select
									className="otta-focusable"
									data-testid="filter-period"
									style={inputStyle}
									value={draft.period ?? statusAny}
									onChange={(event) => setDraft({ ...draft, period: event.target.value })}
								>
									{(vocabulary?.periods ?? []).map((period) => (
										<option key={period.key} value={period.key}>
											{period.label}
										</option>
									))}
								</select>
							</Field>
						)}

						<Field label={ORDERS_SEARCH_LABEL}>
							<input
								type="search"
								className="otta-focusable"
								data-testid="filter-search"
								style={inputStyle}
								value={draft.search ?? ""}
								onChange={(event) => setDraft({ ...draft, search: event.target.value })}
							/>
						</Field>
					</div>
					<div style={{ marginBlockStart: 12 }}>
						<Button
							label={APPLY_FILTERS_LABEL}
							testId="apply-filters"
							onClick={() => apply(normalize(draft, statusAny))}
						/>
					</div>
				</Group>
			)}

			{filtered && filtersVisible && (
				<section
					data-testid="orders-filter-summary"
					style={{
						...panelStyle,
						display: "flex",
						gap: 12,
						alignItems: "center",
						justifyContent: "space-between",
						padding: "10px 14px",
					}}
				>
					<span style={{ fontSize: 13 }}>{parts.join(" · ")}</span>
					<Button label={CLEAR_FILTERS_LABEL} testId="clear-filters" onClick={() => apply({})} />
				</section>
			)}

			{busy && page === null && failure === null && (
				<p style={{ fontSize: 13, opacity: 0.7 }} aria-live="polite">
					Loading orders…
				</p>
			)}

			{/*
			  OUTCOMES 2 / 2b / 4 — the empty state REPLACES the table. Which words
			  and which offer are the shared decision's, not this file's: `way-in`
			  is an empty collection on page 1, `clear-filters` is a filter narrowed
			  to nothing, and `none` is a page that ran off the end — page-scoped
			  wording with nothing to click, because there is no filter to clear and
			  no "back to the first page" control to fabricate.
			*/}
			{page !== null && outcome.kind === "empty" && answerVisible && (
				<EmptyState
					testId={
						outcome.offer === "clear-filters"
							? "orders-no-match"
							: outcome.offer === "way-in"
								? "orders-empty"
								: "orders-page-zero"
					}
					title={outcome.title}
					description={outcome.description}
					{...(outcome.offer === "clear-filters"
						? { action: { label: CLEAR_FILTERS_LABEL, onClick: () => apply({}) } }
						: {})}
				/>
			)}

			{/*
			  OUTCOME 3 — zero rows with another page BEHIND them. NO empty state:
			  one would sit on top of `Load more` and strand the operator mid-scan
			  on a page that is not the end of anything. The note says what to do
			  with the button that is still there.

			  UNLESS THE BUTTON IS NOT THERE. `pagingStopped` withdraws it, and this
			  note's whole content is an instruction to press it — "Load more scans
			  further" printed directly above a notice explaining that paging has
			  stopped is the screen contradicting itself in two consecutive
			  paragraphs. Reachable on a scan that has matched NOTHING yet (zero rows,
			  a cursor still behind them) when the continuation is refused: the count
			  is zero, `hasNext` is still true because the cursor is deliberately kept,
			  so this branch is live at the exact moment its advice stops being true.
			  The paging-stopped notice says what to do instead, so it replaces this
			  rather than sitting under it.
			*/}
			{page !== null && outcome.kind === "scan" && answerVisible && !pagingStopped && (
				<p
					data-testid="orders-scan-note"
					style={{ fontSize: 13, opacity: 0.8, marginBlockEnd: 12 }}
				>
					{outcome.scanNote}
				</p>
			)}

			{outcome.kind === "rows" && answerVisible && (
				<Table
					testId="orders-table"
					caption="Orders"
					card
					headers={["Placed", "Customer", "Status", "Order #", <EndHeader label="Total" />]}
					onActivateRow={onOpen}
				>
					{orders.map((order) => {
						const prefix = shortIds.get(order.id) ?? shortIdFixed(order.id);
						return (
							<tr
								key={order.id}
								className="otta-row"
								data-testid="orders-row"
								data-row-id={order.id}
							>
								{/*
								  F16: TWO ANCHORS PER ROW — who, and how much. Customer and
								  total carry the weight; the date and the id prefix recede to
								  0.72; the status keeps 400 so the pill below is the only thing
								  that stands out in that column. Every cell stays 13px: an
								  operator scanning forty rows wants a stable grid, not a ramp.
								*/}
								<td className="otta-td otta-num" style={{ opacity: 0.72 }}>
									{formatTimestamp(order.createdAt)}
								</td>
								<td
									className="otta-td"
									style={{
										fontWeight: 600,
										// LAYOUT CONTAINMENT, NOT STRING CLAMPING (review finding N1,
										// director ruling). `buyerRef` is caller-supplied free text up
										// to 320 characters with no format check
										// (`packages/service/src/schemas.ts`), and this column has no
										// bound of its own under the table's `table-layout: auto`: one
										// unbroken long token would otherwise widen this column and
										// push every column to its right — Status, Order #, Total — off
										// the table card's `overflow-x: auto`, which the operator would
										// then have to scroll sideways to find. `overflowWrap` IS THE
										// LOAD-BEARING DECLARATION: it is what lets the browser satisfy
										// `maxInlineSize` at all by giving it somewhere to put the
										// characters that don't fit — WITHOUT it, `max-width` on a `td`
										// under `table-layout: auto` is only ADVISORY, and a browser
										// will still widen the column past it rather than break an
										// unbreakable token (verified against this exact fixture: round
										// 3's screenshots are the wrap, not the cap, doing the work). Do
										// not drop `overflowWrap` while keeping `maxInlineSize` — that
										// keeps the number in the code and loses the behaviour it
										// implies. The value stays fully selectable and copy-pasteable,
										// which a DOM truncation could not honestly promise. THE
										// PRINCIPLE: layout containment via CSS wherever the full value
										// must remain copyable; string clamping only in prose
										// (`order-detail.tsx`'s `resolveRefundRecipient`), which cannot
										// wrap its way out of a reshaping attack the way a table cell
										// can. KNOWN, ACCEPTED TRADE-OFF: at narrow widths a
										// near-maximum-length `buyerRef` wraps across many lines and
										// makes that one row tall — every cell in the row grows with
										// it, since a `<tr>` cannot vary its own cells' heights. Left as
										// is; the alternative is clamping the value, which is the thing
										// this fix exists to avoid.
										maxInlineSize: 360,
										overflowWrap: "anywhere",
									}}
									// The uuid is reachable from the row without being printed on
									// the page — the same split the products list makes between
									// the SKU it prints and the id it carries only as an attribute.
									// React omits a `data-*` attribute whose value is `null` OR
									// `undefined`; the `?? undefined` here is only to satisfy the
									// attribute's TypeScript type (`customerId` is `string | null`),
									// not what makes the omission happen. Covered by the guest/
									// unclaimed-row case in `orders-row-ink-dom.test.tsx`.
									data-customer-id={order.customerId ?? undefined}
								>
									{/* THIS WAS BACKWARDS: the cell used to read
									  `order.customerId ?? order.buyerRef`, showing the readable
									  reference only on an UNCLAIMED order — the one where the LEAST
									  is known about the buyer — and an opaque uuid on every CLAIMED
									  one. `buyerReferenceText` is shared with the detail heading
									  (`order-detail.tsx`, `@otta-sh/admin-presentation`) so the two
									  screens cannot drift back apart on this rule. */}
									{buyerReferenceText(order.buyerRef)}
								</td>
								<td className="otta-td">
									{order.state === PILLED_ORDER_STATE ? (
										<StatusPill tone="fail" testId="order-state-pill">
											{orderStateCell(order.state)}
										</StatusPill>
									) : (
										orderStateCell(order.state)
									)}
								</td>
								<td className="otta-td" style={{ whiteSpace: "nowrap" }}>
									{/*
									  DESIGNER §8: the PRIMARY CELL is the link, and it stays the row's
									  ONLY tab stop now that the whole row activates — the row itself
									  takes no `tabindex`, and the descendant guard is what stops this
									  link and the copy button firing twice. The identity cell is the
									  one that opens the record, and the copy button sits beside it so
									  §1.3's two halves — prefix on screen, full id in the clipboard
									  — are one affordance in one place.
									*/}
									<a
										href={`?order=${encodeURIComponent(order.id)}`}
										className="otta-focusable otta-link"
										data-testid="order-link"
										data-order-id={order.id}
										onClick={(event) => {
											// A MODIFIED CLICK IS THE BROWSER'S, NOT OURS. Ctrl/Cmd/shift
											// click and middle-click are how order ops opens three orders
											// in three tabs, and `preventDefault()` on all of them turns
											// the one genuinely linkable thing on this screen back into a
											// button. The `href` is real, so letting these through costs
											// nothing and gains the affordance.
											if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
												return;
											}
											event.preventDefault();
											onOpen(order.id);
										}}
										style={orderLinkStyle}
									>
										{prefix}
									</a>
									<CopyIdButton id={order.id} testId="copy-order-id" revealOnRowHover />
								</td>
								<td className="otta-td otta-num" style={{ ...endCellStyle, fontWeight: 600 }}>
									{formatAmount(order.totalCents, order.currency)}
								</td>
							</tr>
						);
					})}
				</Table>
			)}

			{/*
			  THE CONTINUATION FAILURE RENDERS WHERE `Load more` WAS, and replaces
			  it: the button and the card would otherwise offer the same request
			  twice, and the one that failed is the one the operator just pressed.
			*/}
			{card !== null && card.inline && (
				<div style={{ marginBlockStart: 12 }}>
					<Notice
						variant="error"
						title={card.title}
						description={card.description}
						action={retryAction}
						testId="orders-load-more-failure"
					/>
				</div>
			)}

			{/*
			  PAGING STOPPED MID-SCAN — rendered where `Load more` was, because it is
			  what replaces that control. NO FOCUS MOVE, unlike the seeded-link
			  notice: the operator is mid-interaction with their hands on the page,
			  and taking focus off what they were doing to announce a control that
			  simply is not there any more would be the more disruptive answer to the
			  smaller problem.
			*/}
			{pagingStopped && answerVisible && (
				<div style={{ marginBlockStart: 12 }}>
					<Notice
						variant="alert"
						title={PAGING_STOPPED_TITLE}
						description={PAGING_STOPPED_DESCRIPTION}
						testId="orders-paging-stopped"
					/>
				</div>
			)}

			{page?.nextCursor != null && failure === null && !pagingStopped && (
				<div style={{ marginBlockStart: 12 }}>
					<button
						type="button"
						className="otta-focusable otta-btn"
						data-testid="orders-load-more"
						disabled={busy}
						style={buttonStyle}
						onClick={() => {
							const value = page.nextCursor;
							if (value === null) return;
							setCursor({ filter: applied, value });
							setCursorReset(false);
							// The page goes in the address, and the screen is the only
							// writer — this states what happened, it does not navigate.
							onCursorChange?.(value);
						}}
					>
						{busy ? "Loading…" : LOAD_MORE_LABEL}
					</button>
				</div>
			)}
		</div>
	);
}
