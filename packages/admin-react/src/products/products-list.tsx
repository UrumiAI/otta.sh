/**
 * The React Pricing & inventory list — INC-21, and the second and last screen
 * ADR-0014 migrates.
 *
 * WHAT IS DIFFERENT FROM THE BLOCK KIT SCREEN, and it is the same short list
 * INC-20's Orders list carries, because this is a migration and not a redesign:
 *
 *  - **Row click.** The title cell is a link to the product's detail and the
 *    whole row is a target (DESIGNER §8), through ONE delegated listener on the
 *    table body. A selection guard is what keeps the second column — a code an
 *    operator pastes into a spreadsheet — selectable rather than dead.
 *  - **No picker.** `Open product` is deleted, and with it the `ComboboxList`
 *    duplicate-key React error, which is picker-only.
 *  - **A copy button on the SKU.** See the identity note below.
 *  - **No round trip per interaction.** Opening a product is a state change,
 *    not a POST that replaces the whole block tree.
 *
 * THE IDENTITY RULING, because §1.3 reads differently on this screen than on
 * Orders and the difference is load-bearing.
 *
 * §1.3 governs OPAQUE ids and says in as many words that "Orders is the only
 * screen showing an opaque uuid". This one shows none: the product uuid lives
 * in `option.value` on the Block Kit picker and in the drill path, and is
 * rendered nowhere. What identifies a row to an operator is the **SKU** — a
 * natural key, the thing low stock is reported by, the thing a purchase order
 * is written against — and §1.3 exempts natural keys explicitly (it makes the
 * same call for Tax and Shipping's slug ids and for Coupons' `Code`). So the
 * SKU renders IN FULL, with no prefix and no truncation, and the React tier's
 * contribution is the copy button beside it rather than a short-id scheme this
 * screen has no use for. Applying the prefix rule here would shorten the one
 * value on the row that an operator has to read whole.
 *
 * The uuid is still on the row — in the link's `href` and its `data-product-id`
 * — because that is what navigates. It is not rendered.
 *
 * WHAT IS DELIBERATELY NOT DIFFERENT:
 *
 *  - **Sorting stays OFF** (§1.2): sort is not wired through
 *    `ListLevelDef.fetchPage` into the list ports, so a client-side sort would
 *    order the LOADED PAGE and silently present it as the order of the list.
 *  - **Filtering stays SERVER-SIDE**, keyset-paged at 25 — "Low stock only"
 *    included. It USED TO be the one exception: the service's products list
 *    had no stock predicate, so the plugin narrowed the fetched page itself
 *    and withheld the `total` (the service's count described a different set
 *    of rows than the ones on screen). It is a real predicate now — the
 *    plugin resolves the store's threshold and carries it on the request the
 *    same as every other filter — so `Load more` is a genuine next page, the
 *    `total` (when the plugin can resolve one) DESCRIBES the rows on screen
 *    and is shown, and `countScope` is unconditionally `"service-filtered"`
 *    below. The one thing that can still go wrong is the threshold itself
 *    being unreadable, in which case the plugin sends no predicate at all and
 *    says so via `stock.filterUnavailable` — see `narrowed` below.
 */
import {
	ABSENT,
	ACCUMULATED_SUFFIX,
	APPLY_FILTERS_LABEL,
	CLEAR_FILTERS_LABEL,
	LOAD_MORE_LABEL,
	LOW_STOCK_FILTER_DESCRIPTION,
	LOW_STOCK_FILTER_LABEL,
	PAGER_LABEL,
	PRODUCTS_EMPTY,
	PRODUCTS_LIST_INTRO,
	PRODUCTS_PAGE_FAILED_TITLE,
	PRODUCTS_LOW_STOCK_NOUN,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	PRODUCTS_NOUN,
	PRODUCTS_NO_MATCH,
	PRODUCTS_SCREEN_TITLE,
	PRODUCT_COLUMN_LABELS,
	PRODUCT_FILTER_LABELS,
	RETRYING_LABEL,
	RETRY_LABEL,
	UNTITLED,
	formatOptionalAmount,
	listOutcome,
	onHandCell,
	productFilterParts,
	statusLabel,
	statusTone,
	stockDegradation,
	stockTone,
	type ProductTone,
} from "@otta-sh/admin-presentation";
import * as React from "react";
import {
	CURSOR_RESET_DESCRIPTION,
	CURSOR_RESET_TITLE,
	FIRST_PAGE,
	PAGING_STOPPED_DESCRIPTION,
	PAGING_STOPPED_TITLE,
	REFRESH_FAILED_TITLE,
	REFRESH_STOPPED_DESCRIPTION,
	REFRESH_STOPPED_TITLE,
	REFRESH_UNCHANGED_NOTE,
	askedForPage,
	continuationCursor,
	landedTrail,
	mergeById,
	pagerView,
	poppedPage,
	pushedPage,
	refreshControl,
	refreshWalk,
	sameFilter,
	seedCursor,
	seedTrail,
	walkWindow,
	type PageArrival,
	type PageChange,
	type PageTrail,
	type PendingCursor,
} from "../accumulate.js";
import {
	fetchProducts,
	isFailure,
	type ProductSummary,
	type ProductsFilter,
	type ProductsVocabulary,
	type StockContext,
} from "../console-api.js";
import {
	Button,
	CopyIdButton,
	EmptyState,
	EndHeader,
	Field,
	Group,
	Notice,
	PagerButton,
	StatusPill,
	Table,
	buttonStyle,
	endCellStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";

/** Re-exported so this screen's own modules and its tests name the shared
 *  fallback once, without importing the presentation package for one string. */
export { UNTITLED };

/**
 * A phrase, ringed only when the record says it is an exception (D1).
 *
 * BADGE THE EXCEPTION, LEAVE THE HAPPY PATH BARE. A sellable active product and
 * a healthy count are the quiet majority of both columns, and a mark on every
 * row marks nothing — so `plain` returns the phrase itself, with no wrapper and
 * no attribute. The tone comes from the RECORD, through the shared derivations,
 * so the ink cannot disagree with the words beside it or drift from what the
 * Block Kit screen decides about the same product.
 *
 * IT WRAPS THE PHRASE, IT NEVER MAKES ONE: the caller passes the shared label,
 * so the copy module stays the single source of wording.
 */
export function toned(tone: ProductTone, phrase: string, testId: string): React.ReactNode {
	return tone === "plain" ? (
		phrase
	) : (
		<StatusPill tone={tone} testId={testId}>
			{phrase}
		</StatusPill>
	);
}

/** The title cell's link, and the only tab stop in its row.
 *
 *  UNDECORATED AT REST, unlike the Orders prefix — and not as a reading of the
 *  two columns. F18 specifies this list's link in as many words: "the title link
 *  stays undecorated at rest and underlines on row hover". Both halves are the
 *  requirement. The rest state is the shared `.otta-link` class's own `none`;
 *  the row-hover half is why this call site adds `.otta-link-row`, the modifier
 *  the sheet's row-hover trigger names and the Orders prefix does not carry.
 *  Hover and keyboard focus come from `.otta-link` itself, so that much of the
 *  affordance is identical on both lists.
 *
 *  Weight 600 is F16's title anchor as much as F18's link: the title IS this
 *  cell's content, so one declaration serves both rather than the cell and the
 *  link each carrying their own. The negative margin pays back the padding, so
 *  the hit area exceeds the glyphs without the row growing around it. */
const productLinkStyle: React.CSSProperties = {
	color: "inherit",
	fontWeight: 600,
	padding: "2px 4px",
	margin: "-2px -4px",
};

/**
 * Whether the filter panel and its summary are on the screen (F3).
 *
 * ONLY A COLD FAILURE TAKES THEM, and "cold" is `page === null` — nothing has
 * ever landed, so the two selects have no vocabulary and would render as empty
 * menus offering the operator no way to filter differently. That is the same
 * call the Orders list makes, and this screen's `clearAnswer` is what makes the
 * other half of it true: a STALE failure keeps `vocabulary` precisely because
 * the panel is built from it, so those selects stay populated and the bar stays.
 *
 * A load in progress is not a failure. Before the first response there is no
 * failure to report, so the bar renders, exactly as it does on every mount.
 */
export function filtersVisible(page: LoadedPage | null, failed: boolean): boolean {
	return !failed || page !== null;
}

/**
 * One string per authored filter that is not at its default — the same parts
 * the Block Kit panel counts as `(N active)` and summarises beneath itself.
 *
 * THE COMBINED STATUS SELECT IS ONE PART, exactly as it is on the Block Kit
 * screen (L-3): `active` and `archived` share one control, so they contribute
 * one string. The value is the raw token (`true` / `false` / `archived`), which
 * is what the Block Kit summary renders — matching it is the point, and a
 * prettier rendering here would be a deviation the acceptance forbids.
 */
export function activeFilterParts(filter: ProductsFilter, any: string): string[] {
	// The SENTINEL-STRIPPING is this surface's — it stores one token per select
	// and `any` means "no constraint" — and the WORDING is the shared one, so
	// this panel and the Block Kit panel count the same parts and spell them the
	// same way.
	const notAny = (value: string | undefined): string | undefined =>
		value !== undefined && value !== any && value.length > 0 ? value : undefined;
	return productFilterParts({
		status: notAny(filter.status),
		kind: notAny(filter.productKind),
		...(filter.lowStock === true ? { lowStock: true } : {}),
		...(filter.search !== undefined ? { search: filter.search } : {}),
	});
}

/** Trim a submitted form down to the fields that are NOT at their default —
 *  which is what makes "active filters" countable and what the plugin's own
 *  `filterFormFromValues` expects to receive. */
function normalize(draft: ProductsFilter, any: string): ProductsFilter {
	return {
		...(draft.status !== undefined && draft.status !== any && draft.status.length > 0
			? { status: draft.status }
			: {}),
		...(draft.productKind !== undefined && draft.productKind !== any && draft.productKind.length > 0
			? { productKind: draft.productKind }
			: {}),
		...(draft.lowStock === true ? { lowStock: true } : {}),
		...(draft.search !== undefined && draft.search.length > 0 ? { search: draft.search } : {}),
	};
}

/** One response, before it is merged into what is already on screen. */
export interface ProductsResponse {
	readonly products: readonly ProductSummary[];
	readonly nextCursor: string | null;
	/** INC-23's exact filtered-set count, when the service reports one AND this
	 *  render is entitled to state it. */
	readonly total: number | undefined;
	readonly stock: StockContext;
	readonly vocabulary: ProductsVocabulary;
}

interface LoadedPage extends ProductsResponse {
	/** Whether the rendered rows START at the catalog's first page — which, now
	 *  that pages accumulate, stays TRUE across a `Load more`: the rows above are
	 *  still there. */
	readonly firstPage: boolean;
	/** How many responses these rows were merged from. `1` is the ordinary
	 *  render; anything above it is what makes "on this page" the wrong words. */
	readonly pages: number;
}

/**
 * WHAT A SUCCESSFUL RESPONSE DOES TO THE ROWS ALREADY ON SCREEN (F24).
 *
 * The defect this replaces was one line: the response was ASSIGNED into list
 * state, so a successful `Load more` threw away the page the merchant was
 * reading. On THIS screen that is what made a low-stock scan useless — the
 * matches the merchant had already gathered vanished at the exact moment they
 * asked to see more of them.
 *
 * THREE ARRIVALS, NOT TWO — see {@link PageArrival}. `extend` is `Load more`
 * (and a Retry of it); `replace` is a pager step or a deep link, which move the
 * window rather than growing it; everything else is a `reset`, including a
 * filter change and a first mount.
 *
 * THE CURSOR, THE VOCABULARY AND THE STOCK CONTEXT TAKE THE NEW PAGE'S VALUES;
 * on an `extend` the rows merge by id (see {@link mergeById}) and `firstPage` is
 * inherited, because a scan that began at the first page still starts there
 * after its second page lands.
 *
 * `filterUnavailable` IS THE ONE EXCEPTION, AND IT LATCHES ACROSS BOTH KINDS OF
 * CONTINUATION — the long argument is at the branch itself.
 *
 * `unreadable` DOES NOT LATCH, deliberately. It describes how the newest
 * response could be RENDERED — whether its own rows carry an on-hand figure —
 * and the newest response is what the column shows; the latch exists only
 * because `filterUnavailable` gates a CLAIM about the whole accumulation.
 */
export function nextPage(
	current: LoadedPage | null,
	incoming: ProductsResponse,
	arrival: PageArrival,
): LoadedPage {
	if (arrival === "reset") return { ...incoming, firstPage: true, pages: 1 };
	/*
	 * THE LATCH SURVIVES A PAGER STEP, and getting this wrong was the sharpest
	 * defect the pager introduced.
	 *
	 * `filterUnavailable` is not a property of the rows; it is the answer to "was
	 * the merchant's low-stock filter ever applied to what you are looking at",
	 * and only PAGE ONE can answer it. Every request carrying a cursor reports
	 * `false` by contract (`resolveStockContext`'s decision 3), because the
	 * predicate rode inside the opaque token and the plugin has nothing to
	 * re-check. So a continuation has NO answer of its own — `false` there means
	 * "not asked", not "the filter ran".
	 *
	 * The first cut inherited the latch only on an `extend`, on the reasoning that
	 * a replaced window is a single page and a single page speaks for itself. It
	 * does not: `Next` from a first page whose threshold could not be read sends a
	 * cursor exactly like `Load more` does, gets the same contractual `false`
	 * back, and would drop the banner and start captioning every product in the
	 * catalog as low stock — at the click of a control that has nothing to do with
	 * filtering. The latch therefore rides on the CONTINUATION, not on the merge.
	 *
	 * AND ONLY ON A CONTINUATION. A request that put no cursor on the wire —
	 * `Previous` off the bottom of the stack as much as a filter apply — is page
	 * one, answered authoritatively, and arrives as a `reset` above: it may clear
	 * a stale banner and it may raise a fresh one. Latching there would have been
	 * the same defect pointing the other way, with a banner nothing could ever
	 * dismiss.
	 *
	 * KNOWN LIMIT, STATED RATHER THAN HIDDEN: a continuation with NOTHING BEHIND
	 * IT — a page deep-linked straight from an address — has no page-one answer to
	 * inherit, so it takes the contractual `false` at face value and shows no
	 * banner even if the threshold is unreadable. The screen cannot do better
	 * without a second request it has no reason to make: the fact simply is not on
	 * the wire for that page. It self-corrects the moment the merchant pages back
	 * to the first page or applies a filter.
	 *
	 * THE `total` GOES WITH IT for page one's own reason: the count that arrives
	 * is the count of every product while the merchant asked for the low-stock
	 * ones, so honouring it would put a confident exact number under a banner
	 * saying the filter was skipped.
	 */
	const filterUnavailable = current?.stock.filterUnavailable ?? incoming.stock.filterUnavailable;
	const carried = {
		...incoming,
		stock: { ...incoming.stock, filterUnavailable },
		...(filterUnavailable ? { total: undefined } : {}),
	};
	// A WINDOW THAT MOVED, or one with nothing to merge into: the page stands on
	// its own, and it does not start at the first page.
	if (arrival === "replace" || current === null) {
		return { ...carried, firstPage: false, pages: 1 };
	}
	return {
		...carried,
		products: mergeById(current.products, incoming.products, (product) => product.productId),
		firstPage: current.firstPage,
		pages: current.pages + 1,
	};
}

/**
 * Drop the ANSWER from a loaded page while keeping what the page is not (F2).
 *
 * Same rule as the Orders list: the rows, the cursor and the exact count go
 * together — a count without its rows is the same false claim in fewer words,
 * and `12 products · …` over an error notice is the defect F2 names.
 *
 * THIS IS THE FIRST-PAGE CASE ONLY, now that pages accumulate. A page that
 * failed BEHIND one that succeeded disproves nothing already on screen; see
 * {@link pageAfterFailure}, which is what the effect actually calls.
 *
 * The VOCABULARY AND THE STOCK CONTEXT SURVIVE, because they are not the
 * answer: they are what the filter panel's two selects are built from, and
 * clearing them would answer a failed load by emptying the controls the
 * operator needs to retry it differently.
 */
export function clearAnswer(page: LoadedPage | null): LoadedPage | null {
	return page === null ? null : { ...page, products: [], nextCursor: null, total: undefined };
}

/**
 * What a failed response leaves of the page.
 *
 * THE PARTIAL CASE ARRIVED WITH ACCUMULATION (F24). "On failure, clear the
 * page" was right for this screen while a second page replaced the first, and
 * is wrong the moment the first page survives the second: a request that failed
 * BEHIND one that succeeded disproves none of the rows above it, and clearing
 * them would throw away a low-stock scan the merchant may have spent several
 * pages building.
 *
 * THE CURSOR STAYS TOO, and taking it was a defect rather than tidiness. A
 * cursor is this render's evidence that the collection continues past the rows
 * on screen, and a failed attempt to follow it does not disprove that. Nulling
 * it flipped `hasNext` false, which flipped the outcome to a completed scan,
 * which dropped the qualifier off the count — turning a mid-scan
 * "6 low-stock products loaded so far" into "6 low-stock products", a
 * whole-set claim made at the exact moment the render knows another page is
 * out there. Reachable whenever no `total` is on the response to carry the
 * claim instead — a service older than `total`, or a page the low-stock filter
 * could not be applied to. Worse at zero rows: a zero-row page with a cursor
 * behind it turned from a scan note with paging still offered into an empty
 * state offering `Clear filters`, dead-ending the scan.
 *
 * SO THE CONTROL IS GUARDED INSTEAD OF THE STATE DESTROYED. `Load more` renders
 * on `there is no failure` as well as on the cursor, so it does not stand beside
 * a notice already carrying the Retry for the same request; the retry re-runs
 * from the cursor the page kept, and its response merges onto the rows that
 * stayed. Same shape as the Orders list, which had it right.
 */
export function pageAfterFailure(page: LoadedPage | null, paging: boolean): LoadedPage | null {
	return paging ? page : clearAnswer(page);
}

/**
 * WHERE A FAILURE IS DRAWN, AND WHAT IT IS ENTITLED TO CLAIM.
 *
 * TWO PLACES, NOT ONE, and the split is the same one the Orders list makes —
 * this screen inherits the accumulated-pages state F24 gave it, so it inherits
 * that state's design rather than an exemption from it.
 *
 *  - A COLD OR STALE failure is about the whole screen: nothing on it is true
 *    any more, so the service's own whole-collection title stands at the top,
 *    above the space the rows used to occupy.
 *  - A PAGING failure is about ONE REQUEST, and the rows above it are the answer
 *    to a different one that succeeded. Rendering the service's whole-collection
 *    refusal over rows that are still on screen states something those rows
 *    disprove, so the title shrinks to the claim this render can back — ONE page
 *    failed, in whichever direction it was asked for — and it is drawn inline,
 *    where the paging controls were, because that is what it replaces.
 *  - A REFRESH THAT RE-READ NOTHING is the paging case in every respect that
 *    decides behaviour — the rows stand, the card is inline, the Retry re-issues
 *    the same request — and differs only in what it is called. "That page could
 *    not be opened" would name a page move the merchant never made.
 */
export function failureNotice(
	failure: {
		readonly title: string;
		readonly description: string;
		readonly paging: boolean;
		readonly refresh?: boolean;
	} | null,
): { readonly title: string; readonly description: string; readonly inline: boolean } | null {
	if (failure === null) return null;
	if (failure.paging) {
		return {
			title: failure.refresh === true ? REFRESH_FAILED_TITLE : PRODUCTS_PAGE_FAILED_TITLE,
			description: failure.description,
			inline: true,
		};
	}
	return { title: failure.title, description: failure.description, inline: false };
}

/**
 * The stock alert a page earned, WITHDRAWN with that page's answer.
 *
 * `clearAnswer` keeps `stock` because the filter panel is built from it, but the
 * alert is not the panel: "Stock levels are unavailable — for every row here"
 * is a claim about rows that a failure has just taken off the screen, and left
 * standing it sits beside the failure notice describing a response that is
 * gone. It goes with the table, for the same reason the count line does.
 */
export function visibleDegradation(
	page: LoadedPage | null,
	failed: boolean,
): { readonly title: string; readonly description: string } | undefined {
	if (page === null || failed) return undefined;
	return stockDegradation({
		unreadable: page.stock.unreadable,
		thresholdUnreadable: page.stock.threshold === null,
		filterUnavailable: page.stock.filterUnavailable,
	});
}

export function ProductsList({
	onOpen,
	initialFilter = {},
	initialCursor,
	initialTrail,
	onFilterChange,
	onCursorChange,
}: {
	onOpen: (productId: string) => void;
	/** The filter the address bar arrived with (F22). BOTH the applied filter and
	 *  the draft are seeded from it, so a shared link lands filtered AND the panel
	 *  shows why, rather than reading as an unfiltered catalog that mysteriously
	 *  holds four rows. */
	initialFilter?: ProductsFilter;
	/** The page the address bar arrived with — an opaque service token, moved
	 *  verbatim and never inspected. IT IS THE PAGE, NOT THE SCAN: a reload, and
	 *  equally a Back onto an earlier page's entry, restores that one page rather
	 *  than the accumulation the merchant had built. What the count line then says
	 *  is the service's call, not this prop's: with a `total` on the response — the
	 *  ordinary case — it states the whole filtered set on every page, and only a
	 *  service that omits the field leaves it on the page-scoped hedge. Same
	 *  contract, same reasoning, as the Orders list. */
	initialCursor?: string;
	/** THE WALK THE HISTORY ENTRY RECORDED, when it recorded one. A URL carries
	 *  one cursor, which is what makes a link shareable; a history entry is this
	 *  browser's private record of somewhere this merchant already stood, and can
	 *  carry the stack the address cannot. Without it, Back onto a page they had
	 *  walked to came back UNGROUNDED — the position fell to a dash and `Previous`
	 *  dimmed, two presses into a scan. Absent is a deep link, which is the honest
	 *  default. Same contract as the Orders list. */
	initialTrail?: PageTrail;
	/** Announced whenever the applied filter changes, for the screen to write to
	 *  the URL. The list never touches history itself: one writer. */
	onFilterChange?: (filter: ProductsFilter) => void;
	/** Announced whenever the page the list is showing changes — a cursor the
	 *  merchant paged to, or `undefined` for "back at page one". The list states
	 *  what happened; the screen decides what it does to the history stack. ITS
	 *  IDENTITY MUST BE STABLE ACROSS RENDERS: it is a dependency of the fetch
	 *  effect, so a fresh arrow per render would re-fetch on every render. The
	 *  screens wrap it in `useCallback`. */
	onCursorChange?: (change: PageChange) => void;
}): React.ReactElement {
	const [applied, setApplied] = React.useState<ProductsFilter>(initialFilter);
	const [draft, setDraft] = React.useState<ProductsFilter>(initialFilter);
	const [page, setPage] = React.useState<LoadedPage | null>(null);
	/** `paging` records WHICH request failed — a page the merchant MOVED to, or a
	 *  fresh load — because that is what decides whether the rows on screen are
	 *  disproved by the failure or untouched by it. Not "did a cursor go out":
	 *  `Previous` onto page one sends none and is still a move. See
	 *  {@link askedForPage}. */
	const [failure, setFailure] = React.useState<{
		title: string;
		description: string;
		paging: boolean;
		/** The request that failed was a REFRESH that re-read nothing — see
		 *  {@link failureNotice}. It changes the card's title and nothing else. */
		refresh?: boolean;
	} | null>(null);
	const [busy, setBusy] = React.useState(true);
	// The Retry's OWN in-flight state. `busy` is the whole screen's, and the
	// filter panel stays interactive under a failure notice, so driving the Retry
	// from `busy` would make an "Apply filters" the operator pressed read back as
	// "Retrying…" on a request they never issued.
	const [retrying, setRetrying] = React.useState(false);
	/** The Refresh's own in-flight state, for the same reason the Retry has one:
	 *  its label and its unavailability are about ITS click, and `busy` is every
	 *  read this screen has. */
	const [refreshing, setRefreshing] = React.useState(false);
	/**
	 * A refresh re-read some of its window and then could not read the rest.
	 *
	 * SEPARATE FROM `pagingStopped`, which describes a CONTINUATION that was
	 * refused and withdraws the paging controls. This one withdraws nothing: the
	 * last page it did re-read carries a live cursor, so `Load more` and `Next`
	 * are exactly how the merchant gets the missing depth back — which is why the
	 * sentence names them.
	 */
	const [refreshStopped, setRefreshStopped] = React.useState(false);
	// Bumped by "Apply filters" and by Retry. `Load more` re-runs this effect
	// through the cursor it sets, which is a fresh object on every click, so a
	// service that repeats a cursor VALUE still gets a request.
	const [generation, setGeneration] = React.useState(0);
	/** SEEDED FROM THE ADDRESS, bound to the very filter object that seeded
	 *  `applied` above — see {@link seedCursor}. Binding it to a copy would make
	 *  every deep link fail `continuationCursor`'s identity test and degrade,
	 *  silently, into a first-page reload. */
	const [cursor, setCursor] = React.useState<PendingCursor<ProductsFilter> | null>(() =>
		seedCursor(initialFilter, initialCursor),
	);
	/**
	 * THE PAGES WALKED TO GET HERE — the client-side stack `Previous` pops.
	 *
	 * SEEDED FROM THE SAME ADDRESS THE CURSOR IS, and ungrounded when that address
	 * named a page: a link says WHICH page, never HOW MANY came before it, so this
	 * mount can go forward and come back without ever being entitled to print a
	 * page number. See {@link PageTrail}.
	 *
	 * IT MOVES ON THE CLICK, exactly as the cursor and the address do, and is not
	 * rewound by a refusal — a failed page withdraws the pager rather than
	 * pretending the merchant never asked.
	 */
	const [trail, setTrail] = React.useState<PageTrail>(
		() => initialTrail ?? seedTrail(initialCursor),
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
	 * A PAGE MOVE THAT HAS BEEN ASKED FOR AND HAS NOT LANDED.
	 *
	 * The stack moves on the CLICK and the rows move on the ANSWER, so between them
	 * — and after a move that failed or was refused outright — the stack holds one
	 * entry more than the rows on screen were fetched by. The pager is withdrawn in
	 * exactly those states, so nothing reads the extra entry; a REFRESH would, and
	 * one entry of drift moves its anchor a whole page. See {@link landedTrail}.
	 */
	const pendingMove = React.useRef(false);
	/**
	 * WAS THE LOW-STOCK FILTER UNAPPLIED WHEN THE REFRESH WAS ASKED FOR?
	 *
	 * Captured on the click, because the walk that reads it runs in an effect that
	 * cannot depend on the page without re-fetching on every render — and read only
	 * when the walk is ANCHORED, where the wire cannot answer for itself. The long
	 * argument is at the branch that uses it.
	 */
	const blindAtRefresh = React.useRef(false);
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
	/** The refresh-stopped notice's region, focused when it appears. */
	const refreshStoppedRegion = React.useRef<HTMLDivElement | null>(null);
	/** Where focus goes when `Apply filters` disables itself under its own click. */
	const applyRegion = React.useRef<HTMLDivElement | null>(null);

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
		// DID THE MERCHANT ASK FOR THIS PAGE? Not "is there a cursor on the wire" —
		// `Previous` onto page one sends none and is still a move. See
		// {@link askedForPage}.
		const paging = askedForPage(cursor, applied);
		// WHICH OF THE TWO ADVANCING CONTROLS ISSUED IT. Only `Load more` extends
		// the rows on screen; a pager step and a deep link name a page that stands
		// on its own. See `PendingCursor.extend`.
		const extending = paging && cursor?.extend === true;
		// A REFRESH IS A WALK, NOT A REQUEST — see {@link RefreshWalk}. Read off the
		// same cursor and under the same filter-identity test as everything else, so
		// a walk planned under a filter that has since been replaced refreshes
		// nothing and this list falls through to a fresh first page.
		const walk = paging ? cursor?.refresh : undefined;
		setBusy(true);
		if (walk !== undefined) {
			/*
			 * THE VERDICT PAGE ONE GAVE, CARRIED INTO A WALK THAT DOES NOT OPEN THERE.
			 *
			 * `filterUnavailable` is not a property of rows; it answers "was the low-stock
			 * filter actually applied to what you are looking at", and ONLY a request
			 * carrying no cursor can answer it — every continuation reports `false` by
			 * contract, because the predicate rode inside the opaque token
			 * (`resolveStockContext`). A refresh anchored on a page the operator paged to
			 * therefore gets that contractual `false` for its FIRST response, with nothing
			 * behind it to inherit from, and would take it at face value: the banner would
			 * vanish and the withheld total would reappear at the click of a control that
			 * has nothing to do with filtering — captioning every product in the catalog as
			 * low stock. So the pre-refresh verdict rides into the rebuild, exactly as
			 * `nextPage` carries it across a `Load more`.
			 *
			 * ONLY WHEN THE WALK IS ANCHORED. A walk that opens on page one gets a real
			 * answer and is entitled to raise the banner AND to clear it; carrying a stale
			 * verdict there would be the same defect pointing the other way, with a banner
			 * nothing could ever dismiss.
			 */
			const carried = walk.anchor !== undefined && blindAtRefresh.current;
			void walkWindow({
				walk,
				// ONE REQUEST, READ INTO THE THREE THINGS A WALK CAN BE TOLD. This is the
				// only place this screen's payload is narrowed for a refresh; the control
				// flow around it is shared with the Orders list, because it is one decision.
				fetch: async (at) => {
					const result = await fetchProducts(applied, at);
					if (isFailure(result)) return { kind: "failure", description: result.description };
					if (result.cursorRejected === true) return { kind: "refused" };
					return {
						kind: "answer",
						page: {
							products: result.products,
							nextCursor: result.nextCursor,
							total: result.total,
							stock: carried ? { ...result.stock, filterUnavailable: true } : result.stock,
							vocabulary: result.vocabulary,
						},
						nextCursor: result.nextCursor,
					};
				},
				// BUILT OFF `null`, so the window is REPLACED rather than merged into: a
				// product that has left the catalog — or left the filter — is in none of
				// these responses, and merging would keep it on screen at the exact moment
				// the merchant asked whether it was still there.
				merge: nextPage,
				cancelled: () => cancelled,
			}).then((outcome) => {
				if (outcome === null) return;
				setBusy(false);
				setRetrying(false);
				setRefreshing(false);
				if (outcome.page === null) {
					// NOTHING WAS RE-READ, so nothing is replaced. The window on screen is
					// still the coherent one it was a moment ago — every boundary in it
					// still lines up with the one before — and the honest response is to
					// leave it entirely alone and say the refresh did not happen.
					setFailure({
						title: REFRESH_FAILED_TITLE,
						description: `${outcome.stopped?.description ?? ""} ${REFRESH_UNCHANGED_NOTE}`.trim(),
						paging: true,
						refresh: true,
					});
					return;
				}
				setFailure(null);
				landed.current = true;
				// The window on screen is this walk's, so nothing is outstanding against it.
				pendingMove.current = false;
				// COMMITTED IN ONE TRANSITION, and that is why the responses were collected
				// rather than written as they arrived: a window half re-read carries one
				// count line over rows taken at two different moments.
				setPage(outcome.page);
				setTrail(outcome.trail);
				setCursorReset(false);
				/*
				 * WHICH OF THE TWO "IT STOPPED" STATES THIS IS — and they are not
				 * interchangeable. See `RefreshStop.refused`.
				 *
				 * A walk that was REFUSED ends on a window whose own `nextCursor` IS the
				 * token just rejected, so `Load more` from there re-sends a token this list
				 * has just watched be rejected — and a notice promising it gathers the
				 * missing pages would be walking the merchant into the paging-stopped state
				 * one click later. Paging is withdrawn here instead.
				 *
				 * A walk that merely got NO ANSWER ends on a boundary nothing has disproved,
				 * so paging stands. A walk that reached the end of its window clears both.
				 */
				const refused = outcome.stopped?.refused === true;
				setPagingStopped(refused);
				setRefreshStopped(outcome.stopped !== null && !refused);
				// A CORRECTION, NOT A JOURNEY: the merchant did not go anywhere, and a
				// refresh that pushed an entry would put a Back between them and the page
				// they were already on. The address names the page the window now ENDS on.
				onCursorChange?.({
					cursor: outcome.trail.cursors.at(-1),
					trail: outcome.trail,
					kind: "correct",
				});
			});
			return () => {
				cancelled = true;
			};
		}
		void fetchProducts(applied, from).then((result) => {
			if (cancelled) return;
			setBusy(false);
			// Whatever the outcome, the click that asked for this is over — including
			// a refresh whose walk was abandoned mid-flight by this very request.
			setRetrying(false);
			setRefreshing(false);
			if (isFailure(result)) {
				/*
				 * A FAILURE NEVER RESETS THE PAGE — the same correction, and the same
				 * reasoning, as the Orders list, whose branch carries it in full. Every
				 * failure arrives in one shape, so a refused token cannot be told from an
				 * expired session here; the distinction is made in the plugin's admin
				 * client, which reads the service's refusal code, performs the page-one
				 * recovery itself and reports `cursorRejected` on a SUCCESSFUL payload.
				 * A failure therefore leaves the cursor exactly where it was, in state
				 * and in the address, so a reload after recovery still restores the page.
				 */
				setFailure({ title: result.title, description: result.description, paging });
				// F2: THE ANSWER GOES WITH THE FAILURE, in the same transition — for a
				// FIRST page. A page behind one that succeeded takes only its own
				// cursor with it (F24); see `pageAfterFailure`.
				setPage((current) => pageAfterFailure(current, paging));
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
				// A CORRECTION, NEVER A JOURNEY: the entry the merchant is standing on
				// is rewritten rather than buried under one they never asked for. The
				// stack it records is page one's, which is what a reload of the
				// corrected address would produce — mid-scan that deliberately differs
				// from the in-memory stack, which still describes the rows on screen.
				onCursorChange?.({ cursor: undefined, trail: FIRST_PAGE, kind: "correct" });
				if (midScan) setPagingStopped(true);
				else {
					setCursorReset(true);
					// THE ROWS BELOW REALLY ARE PAGE ONE, so the stack has to say so —
					// otherwise the position would keep the unknowable page the address
					// asked for while the screen showed the first one. The mid-scan
					// branch deliberately does NOT reset: those rows are still the pages
					// the merchant gathered, and the pager is withdrawn there anyway.
					setTrail(FIRST_PAGE);
				}
			}
			if (midScan) {
				// THE ONE RESPONSE THIS SCREEN THROWS AWAY. Every row in it is real and
				// none of it belongs here: it answers a question (page one) nobody on
				// this screen asked, and merging it would reorder a scan around rows the
				// operator has already scrolled past.
				return;
			}
			landed.current = true;
			// The rows on screen are now this response's, so the stack and they agree
			// again — see {@link pendingMove}.
			pendingMove.current = false;
			// F24: MERGE, NEVER ASSIGN. The functional form is required, not
			// stylistic: the rows it merges into are the ones in state at the moment
			// the response lands.
			/*
			 * WHAT THE WIRE SAYS THIS RESPONSE IS — and it is the WIRE, not the
			 * operator's intent, that decides.
			 *
			 * A REQUEST THAT CARRIED NO CURSOR IS PAGE ONE, whoever asked for it. A
			 * filter apply, a first mount and a `Previous` off the bottom of the
			 * stack all send the same empty request and all come back with the same
			 * thing: the first page, under the current predicate, answered
			 * authoritatively. Calling the last of those a `replace` — which the
			 * first cut did, because the OPERATOR had asked for a page — was wrong in
			 * two directions at once. It captioned a render that IS the first page as
			 * `firstPage: false`, which takes the whole-collection empty copy away and
			 * puts the "on this page" hedge on a count the render could prove; and on
			 * Pricing & inventory it carried a latch forward over a response entitled
			 * to clear it, so a banner raised by a settings blip could never go away
			 * — while a blip happening ON that request could not raise one.
			 *
			 * THE FAILURE CLASSIFICATION IS A SEPARATE QUESTION and stays on `paging`.
			 * "Is this response page one" and "do the rows on screen survive this
			 * request failing" are genuinely different questions, and keeping them
			 * apart is what makes answering the first one straight off the wire safe.
			 *
			 * A REFUSED CURSOR IS PAGE ONE TOO: the plugin already performed the
			 * recovery, so these are the first page's rows however they were asked for.
			 */
			const arrival: PageArrival =
				rejected || from === undefined ? "reset" : extending ? "extend" : "replace";
			setPage((current) =>
				nextPage(
					current,
					{
						products: result.products,
						nextCursor: result.nextCursor,
						total: result.total,
						stock: result.stock,
						vocabulary: result.vocabulary,
					},
					arrival,
				),
			);
		});
		return () => {
			cancelled = true;
		};
		// `onCursorChange` IS A DEPENDENCY because the effect calls it — closing over
		// a stale one would announce a page change to a screen that had moved on. Safe
		// only because every caller keeps its identity stable (the screens use
		// `useCallback`); an unstable one would re-fetch on every render.
	}, [applied, cursor, generation, onCursorChange]);

	/**
	 * THE RESET NOTICE HAS TO BE HEARD, not merely rendered. A live region INSERTED
	 * with its text already in place is the one case assistive technology is not
	 * required to announce, and this notice appears unbidden on arrival with
	 * nothing to click — so focus moves to the region, the same destination
	 * `Notice`'s own `handOffFocusTo` uses. It fires only on the transition into
	 * the reset state, which happens once and only just after a mount: paging and
	 * applying filters both clear the flag.
	 */
	React.useEffect(() => {
		if (!cursorReset) return;
		const region = resetRegion.current?.firstElementChild;
		if (region instanceof HTMLElement) region.focus();
	}, [cursorReset]);

	/**
	 * AND SO DOES THE ONE THAT SAYS ROWS WENT. The licence to remove rows rests on
	 * the merchant being able to perceive that it happened, and this notice is where
	 * a partially-refreshed window says how much of itself is no longer shown. Focus
	 * being on the Refresh control is the safety property, not a substitute for the
	 * message, so the announcement is handed to the region exactly as the reset
	 * notice's is.
	 */
	React.useEffect(() => {
		if (!refreshStopped) return;
		const region = refreshStoppedRegion.current?.firstElementChild;
		if (region instanceof HTMLElement) region.focus();
	}, [refreshStopped]);

	const products = page?.products ?? [];
	const vocabulary = page?.vocabulary;
	const any = vocabulary?.any ?? "any";
	const threshold = page?.stock.threshold ?? null;
	const parts = activeFilterParts(applied, any);
	const filtered = parts.length > 0;
	const hasNext = page?.nextCursor != null;
	// A "Low stock only" page reports on ITSELF, never on the catalog, in
	// exactly one case now: when the store's threshold could not be resolved.
	// Same switch the Block Kit screen made, on the same boolean — only the
	// mechanism underneath it changed.
	//
	// APPLIED MEANS APPLIED, NOT MERELY REQUESTED. The checkbox can be checked
	// while the plugin still could not honour it: it sends no predicate at all
	// whenever the low-stock threshold cannot be read
	// (`stock.filterUnavailable`, `resolveStockContext`). Reading `narrowed`
	// off the checkbox alone would then state "137 low-stock products" for an
	// ordinary, unfiltered page of every product — a wrong noun directly above
	// the degradation banner that already says the filter was not applied.
	//
	// `stock` IS THE LATEST RESPONSE'S ANSWER ONLY (see `nextPage`) — exactly
	// right for a single page, and an approximation once pages accumulate: a
	// `filterUnavailable` flip between two `Load more` responses would apply
	// THIS render's scope to rows merged from both, one filtered and one not.
	// Only reachable if the threshold read itself flips mid-scan, and still the
	// smaller, more honest claim than reading the checkbox alone — but worth
	// naming rather than leaving implied.
	const narrowed = applied.lowStock === true && page?.stock.filterUnavailable !== true;

	// THE SHARED DECISION. Same function, same inputs, as the Block Kit screen's
	// `listResult` — so the count line, the wording, and which state renders at
	// all cannot disagree between the two Pricing & inventory screens.
	const outcome = listOutcome({
		count: products.length,
		filtered,
		firstPage: page?.firstPage ?? true,
		hasNext,
		// ALWAYS the ordinary, service-filtered scope now: "Low stock only" is a
		// predicate the SERVICE applies (or, on `filterUnavailable`, honestly
		// did not — see `narrowed` above), never a narrowing this screen does to
		// an already-fetched page. So `firstPage && !hasNext` really does mean
		// the counted set is complete, and a `total` the plugin forwards is
		// honoured exactly as `rowCountLine` validates it — no scope-specific
		// exception left to state.
		countScope: "service-filtered",
		// F29: NAME WHAT WAS COUNTED. While the filter is ACTUALLY applied, the
		// rows are the low-stock ones the service selected, and calling them "3
		// products" invites the merchant to read three as the catalog's answer.
		// The same `narrowed` boolean is why this reverts to the ordinary noun
		// on a `filterUnavailable` page: the rows there are every product, not a
		// low-stock subset, and "low-stock products" would be the wrong word for
		// them.
		noun: narrowed ? PRODUCTS_LOW_STOCK_NOUN : PRODUCTS_NOUN,
		// F24. Once two responses are on screen at once, "on this page" is the
		// wrong sentence for rows drawn from both. The Block Kit tier still
		// replaces rather than accumulates, so it keeps the shared phrasing and
		// the divergence is deliberate.
		...((page?.pages ?? 1) > 1 ? { scopeSuffix: ACCUMULATED_SUFFIX } : {}),
		empty: PRODUCTS_EMPTY,
		// THE LOW-STOCK ZERO STATE IS A WHOLE-CATALOG CLAIM, so it is earned only
		// when the threshold is the ONLY thing that could have emptied the page.
		// The predicates are ANDed: "low stock + Archived", "low stock + Digital"
		// and "low stock + a search" each return nothing on a catalog that is full
		// of low-stock products, and blaming the threshold there sends the operator
		// to Settings to fix a filter. `parts` is the same list the summary above
		// the table is built from, so the sentence and the chips cannot disagree.
		noMatch: narrowed && parts.length === 1 ? PRODUCTS_LOW_STOCK_NO_MATCH : PRODUCTS_NO_MATCH,
		// The plugin has already decided whether this render may state one
		// (`resolveStockContext`: shown once the predicate is genuinely
		// applied, withheld on `filterUnavailable`) — this is simply whatever
		// came through.
		...(page?.total !== undefined ? { total: page.total } : {}),
	});

	// PAGE CONTEXT, NOT ROW DATA: a page narrowed to zero rows still has to be
	// able to say what went wrong, so this is derived from the payload's `stock`
	// rather than from the rows — and it is withdrawn when the page it describes
	// is.
	// A CONTINUATION FAILURE WITHDRAWS NOTHING (F24). The rows above it are the
	// answer to a request that succeeded, so they, the count line and the alert
	// that describes them all stand; only a FIRST-page failure takes them.
	const answerVisible = failure === null || failure.paging;
	const degraded = visibleDegradation(page, !answerVisible);
	// F3: a cold failure has no vocabulary to build the two selects from, so the
	// panel goes with the answer rather than standing there empty.
	const showFilters = filtersVisible(page, failure !== null);
	// WHICH OF THE TWO PLACES THE FAILURE IS DRAWN IN — see `failureNotice`.
	const notice = failureNotice(failure);

	/**
	 * THE PAGER, decided in `pagerView` and only drawn here.
	 *
	 * WITHDRAWN WHEREVER `Load more` IS. A failure has already replaced the offer
	 * to page with a Retry for the request that failed, and the paging-stopped
	 * state has just taken the page out of the ADDRESS — leaving `Previous`
	 * standing there would offer to step back relative to a position the screen
	 * disowned one line above. Both states leave the rows exactly where they are;
	 * it is only the paging that goes.
	 *
	 * THE `total` IS WHATEVER THIS RENDER IS ENTITLED TO STATE — the same value
	 * the count line reads, so a low-stock page whose predicate never ran (see
	 * `nextPage`) withholds the page count exactly as it withholds the count.
	 */
	const pager = pagerView({
		trail,
		hasNext,
		rows: products.length,
		// THE COUNT LINE'S OWN FIGURE, not the payload's — `listOutcome` is the one
		// place a `total` is validated and, on some scopes, withheld, and a page
		// count derived from a number the caption refused would contradict it one
		// line down. On this screen that is not hypothetical: a `filterUnavailable`
		// page withholds its total by design.
		...(outcome.statedTotal !== undefined ? { total: outcome.statedTotal } : {}),
		// HOW MANY PAGES ARE ON SCREEN AT ONCE. Above one the position states the
		// window (`Pages 2–3 of 6`) rather than only where it ends.
		span: page?.pages ?? 1,
		// THE PAGE SIZE IS ON THE WIRE ALREADY — the plugin sends the keyset limit
		// it pages by, so `M` costs no request. A service that omits it leaves the
		// page count an em dash rather than a guess.
		...(vocabulary !== undefined ? { pageSize: vocabulary.pageLimit } : {}),
		busy,
		withdrawn: page === null || !answerVisible || failure !== null || pagingStopped,
	});
	/** The same withdrawal, on the control that was already gated this way. */
	const loadMoreVisible = page?.nextCursor != null && failure === null && !pagingStopped;

	/**
	 * One page forward, from whichever control asked. Both push the same stack;
	 * they disagree only about whether the rows above stay.
	 *
	 * IT READS `trail` OUT OF THE CLOSURE, which is the exception to the functional
	 * `setPage` form a few lines up, and the difference is WHEN the value is
	 * needed. `setPage` runs when a RESPONSE lands, which may be several renders
	 * after the request went out, so it must see whatever is in state then. This
	 * runs inside the click, on the render the merchant is looking at, and the
	 * same value has to reach three places at once — the state, the history entry,
	 * and the cursor — so reading it once is what keeps the three in step. A
	 * functional update here would hand the entry a stack the state had not
	 * committed to.
	 *
	 * THE BUSY GUARD IS STILL LOAD-BEARING, and {@link pushedPage}'s idempotence
	 * does not replace it: repeating a cursor cannot deepen the STACK, but two
	 * presses resolved before the effect runs would still push two history
	 * ENTRIES for one page, and a duplicate entry is not something this tier can
	 * take back.
	 */
	const goForward = (extend: boolean) => {
		const value = page?.nextCursor;
		if (value == null) return;
		setCursor({ filter: applied, value, ...(extend ? { extend: true } : {}) });
		const moved = pushedPage(trail, value);
		setTrail(moved);
		// The stack has moved and the rows have not — see {@link pendingMove}.
		pendingMove.current = true;
		setCursorReset(false);
		// The merchant is doing the thing the notice told them to do; it has nothing
		// left to say the moment they do it.
		setRefreshStopped(false);
		// BUSY IS THE CLICK'S, NOT THE EFFECT'S — the same rule `apply` follows. The
		// effect that issues the request runs after this commit, so without this
		// there is one render in which the position has already moved and both pager
		// controls are still live: a second press would push the SAME cursor again
		// and leave the stack one deeper than the pages actually walked.
		setBusy(true);
		// The page goes in the address, and the screen is the only writer — this
		// states what happened, it does not navigate. `navigate`, because the
		// merchant went somewhere: the entry is pushed, and it carries the stack
		// that produced it so a later Back lands here still knowing where it is.
		onCursorChange?.({ cursor: value, trail: moved, kind: "navigate" });
	};

	/**
	 * One page back, by REPLAYING the cursor the stack popped.
	 *
	 * IT RE-REQUESTS RATHER THAN RESTORING. The stack holds cursors, not pages, and
	 * that is the choice rather than an implementation detail: a re-request under a
	 * token the service already issued is exact and answers with the catalog as it
	 * stands NOW — which on this screen is the whole point, since the column an
	 * operator came back to check is stock. Replaying rows kept in memory would
	 * show a page that may be minutes stale, would disagree with a reload of the
	 * very same address, and would grow without bound down a long scan.
	 *
	 * POPPING THE LAST ENTRY IS PAGE ONE, cursor and all: the request goes out
	 * without a token and the address is corrected through the one path this list
	 * announces its page on.
	 */
	const goBack = () => {
		const { trail: rest, cursor: target } = poppedPage(trail);
		setTrail(rest);
		pendingMove.current = true;
		// A CURSOR OBJECT EVEN WHEN THE PAGE IS ONE. `null` would mean "no page was
		// asked for" and would make a failure here clear the rows — see
		// {@link askedForPage}. Page one is asked for by sending no token, which is
		// a `value` of `undefined`, not by having no request.
		setCursor({ filter: applied, value: target });
		setCursorReset(false);
		setRefreshStopped(false);
		// See `goForward`: the controls go unavailable on the click rather than on
		// the effect, so the commit in between cannot take a second press.
		setBusy(true);
		// NAVIGATE, NOT CORRECT — the correction that shares this shape is the
		// refused-cursor recovery, which REPLACES the entry. A merchant stepping
		// back deliberately went somewhere, and overwriting the entry they stepped
		// from would delete the page they just left from their own history.
		onCursorChange?.({ cursor: target, trail: rest, kind: "navigate" });
	};

	// THE FAILURE IS NOT CLEARED ON THE CLICK. Clearing it here rather than on the
	// response would flash the stale answer back for the length of the request.
	const retryAction = {
		label: retrying ? RETRYING_LABEL : RETRY_LABEL,
		onClick: () => {
			setRetrying(true);
			// A RETRY OF A REFRESH IS A REFRESH — it replays the walk carried on the
			// cursor, not one page — so the control naming that act reads as in-flight
			// too, rather than sitting there live over a walk already running.
			if (cursor?.refresh !== undefined) setRefreshing(true);
			setGeneration((n) => n + 1);
		},
		disabled: retrying,
		busy: retrying,
	};

	/**
	 * RE-READ EVERY PAGE ON SCREEN, AND KEEP THE MERCHANT WHERE THEY ARE.
	 *
	 * THIS SCREEN IS THE ONE THAT NEEDED IT MOST. Its whole reason to accumulate
	 * pages is a low-stock scan, and stock is the fastest-moving number in the
	 * product — so the pages an operator gathers to decide what to reorder are
	 * exactly the pages most likely to be wrong by the time they finish gathering
	 * them. Before this the only ways to re-read them were to lose the scan or to
	 * refresh one page of it.
	 *
	 * IT IS ISSUED AS A CURSOR, like every other read here, which buys the rest of
	 * the machinery for nothing: the walk is refused if the filter has since moved,
	 * its failure is classified as a page move so the rows survive it, and a Retry
	 * re-issues THE WHOLE WALK rather than one page.
	 *
	 * NOTHING HAS LOADED MEANS THERE IS NOTHING TO RECONCILE — a cold screen's act
	 * is Retry, and it is already on the card.
	 */
	const refresh = () => {
		// ONE READ AT A TIME, and the guard is here as well as on the controls: the
		// controls are a rendered state and this is the invariant.
		if (busy || page === null) return;
		blindAtRefresh.current = page.stock.filterUnavailable === true;
		// PLANNED FROM THE STACK THE ROWS ON SCREEN WERE FETCHED BY, which is not the
		// same stack after a page move that failed or was refused — see
		// {@link landedTrail}.
		const walk = refreshWalk(landedTrail(trail, pendingMove.current), page.pages);
		setCursor({ filter: applied, value: walk.anchor, refresh: walk });
		setCursorReset(false);
		setRefreshing(true);
		// BUSY IS THE CLICK'S, NOT THE EFFECT'S — the same rule `apply` and
		// `goForward` follow, and here it is what makes "one read at a time" true of
		// the commit in between rather than only of the request.
		setBusy(true);
	};

	const apply = (next: ProductsFilter) => {
		/*
		 * AN APPLY THAT CHANGES NOTHING IS A REFRESH, NOT A COLLAPSE.
		 *
		 * Throwing away an accumulated scan is licensed by exactly one thing: the
		 * predicate moved, so the cursors underneath those pages describe a set the
		 * merchant has just left. Press `Apply filters` without touching the panel
		 * and none of that is true — it is the same query, restated, and the only
		 * act it can honestly mean is "show me this query as it stands now". That is
		 * this screen's Refresh, so it IS this screen's Refresh.
		 *
		 * THE APPLIED FILTER OBJECT IS DELIBERATELY NOT REPLACED. Its identity is
		 * what every held cursor is tested against ({@link continuationCursor}), so
		 * assigning an equal-but-new object here would invalidate the whole trail to
		 * say nothing had changed.
		 */
		if (sameFilter(next, applied)) {
			// The panel still gets the normalized form, so a submitted sentinel
			// (`any`) settles back to what is actually applied.
			setDraft(next);
			refresh();
			return;
		}
		setApplied(next);
		setDraft(next);
		setCursor(null);
		// A new predicate's first page is asked for outright, so nothing is
		// outstanding against the stack it resets to.
		pendingMove.current = false;
		// THE STACK RESETS WITH THE PREDICATE, and this is not tidiness. A cursor
		// is only meaningful against the filter it was issued under, so a stack that
		// survived an apply would hand `Previous` a token from the set the merchant
		// just left — a page of the old predicate, or (once the service notices the
		// disagreement) a refusal and a bounce back to page one. Page one of the new
		// filter has nothing behind it, and the pager must say so.
		setTrail(FIRST_PAGE);
		// THE RESET NOTICE IS ABOUT THE ARRIVAL, so it goes the moment the merchant
		// asks for something themselves.
		setCursorReset(false);
		// A fresh scan is exactly what the withdrawn control was waiting for.
		setPagingStopped(false);
		// And it is a new window, so what a refresh could not reach in the old one
		// describes nothing on screen.
		setRefreshStopped(false);
		// BUSY IS THE CLICK'S, NOT THE EFFECT'S. Setting it only inside the effect
		// left one commit in which the applied filter had already moved and
		// `Load more` still rendered enabled — offering the previous page's cursor
		// under the new filter. The pairing is refused in `continuationCursor`
		// whatever happens here; this is what stops the control being offered at all.
		setBusy(true);
		setGeneration((n) => n + 1);
		// The cursor deliberately does NOT go with it: paging is where the merchant
		// got to, not what the link describes, and a link that replays N pages is a
		// different feature.
		onFilterChange?.(next);
	};

	return (
		<div>
			<h1 style={{ fontSize: 24, fontWeight: 700, marginBlockEnd: 4 }}>{PRODUCTS_SCREEN_TITLE}</h1>
			{/*
			  REFRESH SITS WITH THE COUNT LINE, not in the paging bar, and the two
			  answer different questions: the bar is about WHERE the merchant is, and
			  this is about WHEN what they are reading was true — which on a stock
			  column is the question. The count line is the sentence a refresh
			  changes, so the control that changes it belongs beside it, and it stays
			  on screen in the states that withdraw the pager entirely.

			  It wraps at narrow widths rather than crowding the sentence, and the
			  paragraph's own bottom margin moves to this row so the spacing below is
			  unchanged whether or not the control is there.
			*/}
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					gap: 12,
					alignItems: "baseline",
					justifyContent: "space-between",
					marginBlockEnd: 16,
				}}
			>
				<p style={{ fontSize: 13, opacity: 0.75 }} data-testid="products-intro">
					{outcome.countLine === undefined
						? PRODUCTS_LIST_INTRO
						: `${outcome.countLine} · ${PRODUCTS_LIST_INTRO}`}
				</p>
				{/* THERE HAS TO BE AN ANSWER TO RECONCILE. A cold or stale failure has
				  taken the rows off the screen and put a Retry on the card, which is
				  the same act by the only name that is true there. */}
				{page !== null && answerVisible && (
					<PagerButton
						control={refreshControl({ busy, refreshing })}
						testId="products-refresh"
						onClick={refresh}
					/>
				)}
			</div>

			{notice !== null && !notice.inline && (
				<Notice
					variant="error"
					title={notice.title}
					description={notice.description}
					action={retryAction}
					testId="products-failure"
				/>
			)}

			{degraded !== undefined && (
				<Notice
					variant="alert"
					title={degraded.title}
					description={degraded.description}
					testId="products-stock-degraded"
				/>
			)}

			{/*
			  THE ADDRESS NAMED A PAGE THAT WOULD NOT OPEN, and this is the first
			  page of its filters instead. An ALERT rather than an error: there is a
			  working list underneath, and what the merchant needs is the one
			  sentence saying they are not where their link said. It is withdrawn
			  with the answer, so it never sits over a cold failure describing rows
			  that are not there. The wrapper is what the focus effect above reaches
			  the live region through.
			*/}
			{cursorReset && answerVisible && (
				<div ref={resetRegion}>
					<Notice
						variant="alert"
						title={CURSOR_RESET_TITLE}
						description={CURSOR_RESET_DESCRIPTION}
						testId="products-cursor-reset"
					/>
				</div>
			)}

			{/*
			  A REFRESH THAT COVERED ONLY PART OF ITS WINDOW — drawn HERE, at the top,
			  because it is the result of the control directly above it and reports a
			  fact about the whole list rather than about paging. The paging-stopped
			  notice at the bottom is the other way round on both counts.

			  NO FOCUS MOVE: the merchant's hands are on the Refresh control, which
			  survives its own click. An ALERT rather than an error — the rows
			  underneath are current, there are simply fewer of them.
			*/}
			{refreshStopped && answerVisible && (
				<div ref={refreshStoppedRegion}>
					<Notice
						variant="alert"
						title={REFRESH_STOPPED_TITLE}
						description={REFRESH_STOPPED_DESCRIPTION}
						testId="products-refresh-stopped"
					/>
				</div>
			)}

			{showFilters && (
				<Group
					label={`Filters${parts.length > 0 ? ` (${String(parts.length)} active)` : ""}`}
					testId="products-filters"
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
							gap: 12,
							alignItems: "end",
						}}
					>
						<Field label={PRODUCT_FILTER_LABELS.status}>
							<select
								className="otta-focusable"
								data-testid="filter-status"
								style={inputStyle}
								value={draft.status ?? any}
								onChange={(event) => setDraft({ ...draft, status: event.target.value })}
							>
								{(vocabulary?.statuses ?? []).map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>

						<Field label={PRODUCT_FILTER_LABELS.kind}>
							<select
								className="otta-focusable"
								data-testid="filter-kind"
								style={inputStyle}
								value={draft.productKind ?? any}
								onChange={(event) => setDraft({ ...draft, productKind: event.target.value })}
							>
								{(vocabulary?.kinds ?? []).map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>

						<Field label={PRODUCT_FILTER_LABELS.search}>
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

					{/*
				  A CHECKBOX RATHER THAN A FIFTH SELECT, as on the Block Kit screen: it
				  is one boolean, and its description states WHERE the threshold lives
				  rather than its value — the number is a service read, and a control
				  that sometimes carries a number and sometimes does not is worse than
				  one that never does. The wording is page-scoped because the filter is.
				*/}
					<label
						style={{
							display: "flex",
							gap: 8,
							alignItems: "flex-start",
							fontSize: 13,
							marginBlockStart: 12,
						}}
					>
						<input
							type="checkbox"
							className="otta-focusable"
							data-testid="filter-low-stock"
							checked={draft.lowStock === true}
							onChange={(event) => setDraft({ ...draft, lowStock: event.target.checked })}
						/>
						<span>
							{LOW_STOCK_FILTER_LABEL}
							<span style={{ display: "block", fontSize: 12, opacity: 0.7 }}>
								{LOW_STOCK_FILTER_DESCRIPTION}
							</span>
						</span>
					</label>

					{/*
					  UNAVAILABLE WHILE A READ IS IN FLIGHT, because this control now has
					  two meanings and both are reads: a changed predicate re-queries, and
					  an unchanged one refreshes the window. Live over a pending request,
					  the second is a silent no-op — `refresh` refuses it and nothing on
					  screen would say so. It hands focus to its own container first, the
					  way the Retry does: a control whose own click disables it drops focus
					  to `<body>` without somewhere to send it.
					*/}
					<div ref={applyRegion} tabIndex={-1} style={{ marginBlockStart: 12 }}>
						<Button
							label={APPLY_FILTERS_LABEL}
							testId="apply-filters"
							disabled={busy}
							handOffFocusTo={applyRegion}
							onClick={() => apply(normalize(draft, any))}
						/>
					</div>
				</Group>
			)}

			{filtered && showFilters && (
				<section
					data-testid="products-filter-summary"
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
					Loading products…
				</p>
			)}

			{/*
			  OUTCOMES 2 / 2b / 4 — the empty state REPLACES the table. Which words
			  and which offer are the shared decision's, not this file's.
			*/}
			{page !== null && outcome.kind === "empty" && answerVisible && (
				<EmptyState
					testId={
						outcome.offer === "clear-filters"
							? "products-no-match"
							: outcome.offer === "way-in"
								? "products-empty"
								: "products-page-zero"
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
			  one would sit on top of `Load more` and strand the operator mid-scan on
			  a page that is not the end of anything.

			  NOT THE ORDINARY CASE ANY MORE. "Low stock only" is a predicate the
			  SERVICE applies across the whole catalog, so a page that comes back
			  empty is usually the end of the filtered set and carries no cursor —
			  the store emits one only when a page overflows its limit. This branch
			  was the ordinary case while the filter narrowed an already-fetched
			  page; it is the exception now, and the cost of being wrong about that
			  is burying the merchant's only way forward.

			  AND IT IS WITHDRAWN WITH THE CONTROL IT DESCRIBES. Its whole content is
			  an instruction to press `Load more`, so printing it above a notice that
			  says paging has stopped would be the screen contradicting itself in two
			  consecutive paragraphs. Reachable on a low-stock scan that has matched
			  nothing yet — zero rows, a cursor still behind them — whose continuation
			  is refused: the cursor is deliberately KEPT (it is the evidence more
			  exists), so `hasNext` stays true and this branch is live at the exact
			  moment its advice stops being true.
			*/}
			{page !== null && outcome.kind === "scan" && answerVisible && !pagingStopped && (
				<p
					data-testid="products-scan-note"
					style={{ fontSize: 13, opacity: 0.8, marginBlockEnd: 12 }}
				>
					{outcome.scanNote}
				</p>
			)}

			{/*
			  `failure === null` IS PART OF THE GUARD, exactly as it is on the two
			  branches above. The table used to render on `outcome.kind` alone while
			  its siblings checked the failure — the inconsistency F1 names — and
			  although `clearAnswer` now empties the rows in STATE and no "rows"
			  outcome can survive a failure, a table whose guard disagrees with the
			  notice above it is how that bug got written the first time.
			*/}
			{outcome.kind === "rows" && answerVisible && (
				<Table
					testId="products-table"
					caption="Products"
					headers={[
						PRODUCT_COLUMN_LABELS.title,
						PRODUCT_COLUMN_LABELS.sku,
						PRODUCT_COLUMN_LABELS.status,
						// `On hand` is NOT end-aligned, and that is the one place this
						// screen departs from the money treatment: its cells carry a
						// trailing phrase (`0 · Out of stock`), so pushing them to the edge
						// would line the WORDS up and leave the digits ragged — the
						// opposite of what aligning a figure column is for. Price has no
						// suffix and gets the treatment.
						PRODUCT_COLUMN_LABELS.onHand,
						<EndHeader label={PRODUCT_COLUMN_LABELS.price} />,
					]}
					onActivateRow={onOpen}
				>
					{products.map((product) => {
						// Derived once, because each is read twice — by the ink and by the
						// pill — and two calls are two places for them to disagree.
						const status = statusTone(product);
						const stock = stockTone(product.onHand, threshold);
						return (
							<tr
								key={product.productId}
								className="otta-row"
								data-testid="products-row"
								data-row-id={product.productId}
							>
								<td className="otta-td">
									{/*
								  DESIGNER §8: the PRIMARY CELL is the link, and it stays the row's
								  ONLY tab stop now that the whole row activates. The title is the
								  human handle (M-10) and the first column on the screen, so it is
								  the cell that opens the record — and the SKU beside it stays
								  plain text, selectable, with its own copy button.
								*/}
									<a
										href={`?product=${encodeURIComponent(product.productId)}`}
										className="otta-focusable otta-link otta-link-row"
										data-testid="product-link"
										data-product-id={product.productId}
										onClick={(event) => {
											// A MODIFIED CLICK IS THE BROWSER'S, NOT OURS. Ctrl/Cmd/shift
											// click is how a merchant opens three products in three tabs
											// to compare their pricing, and `preventDefault()` on all of
											// them turns the one genuinely linkable thing on this screen
											// back into a button.
											if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
												return;
											}
											event.preventDefault();
											onOpen(product.productId);
										}}
										style={productLinkStyle}
									>
										{product.title ?? UNTITLED}
									</a>
								</td>
								<td className="otta-td" style={{ whiteSpace: "nowrap" }}>
									{/*
								  IN FULL. A SKU is a natural key, not an opaque id — §1.3 exempts
								  it, and shortening it would truncate the one value on this row an
								  operator has to read whole. The copy button is the affordance the
								  React tier adds, not a concession to a prefix rule that does not
								  apply here.
								*/}
									{product.sku === null ? (
										ABSENT
									) : (
										<>
											{/*
										  F16: the SKU recedes to 0.75 — and the declaration is on the
										  CODE rather than on the cell, because the cell also holds the
										  copy control, whose own opacity would then be multiplied by
										  this one and land somewhere neither of them chose.
										*/}
											<code data-testid="product-sku" style={{ opacity: 0.75 }}>
												{product.sku}
											</code>
											<CopyIdButton id={product.sku} testId="copy-sku" what="SKU" />
										</>
									)}
								</td>
								{/*
							  F16: TWO ANCHORS PER ROW — the title, and the two operational
							  numbers. SKU and status recede to 0.75; `On hand` and `Price`
							  stay at full strength and weight 400, because they are what a
							  merchant is on this screen to read. Every cell stays 13px: a
							  type ramp would trade a stable grid for emphasis the weight
							  already carries. The recession is opacity, never a second
							  foreground colour, which could not be safe in both themes.
							*/}
								<td
									className="otta-td"
									// RECEDE THE QUIET ANSWER, NOT THE RINGED ONE. F16's 0.75 is
									// there because `active` is the answer on most rows and is not
									// worth reading; a pill exists because its answer IS. Dimming
									// the ring too would be the two decisions cancelling, so the
									// recession applies to the bare phrase only.
									style={status === "plain" ? { opacity: 0.75 } : undefined}
								>
									{toned(status, statusLabel(product), "product-status-pill")}
								</td>
								<td className="otta-td otta-num" data-testid="product-on-hand">
									{/*
								  D1 on a count: `0` and a low count are the two an operator has
								  to act on, and an UNKNOWN count is not one of them — it stays
								  the bare em dash `onHandCell` returns, because absence is not
								  an exception state and a ring around it would claim the store
								  had read something it never read.
								*/}
									{toned(stock, onHandCell(product.onHand, threshold), "product-stock-pill")}
								</td>
								<td className="otta-td otta-num" style={endCellStyle}>
									{/*
								  G1: the row carries integer minor units and the SHARED
								  `formatOptionalAmount` renders them — the same function the Block
								  Kit cell calls, rather than this file's own opinion about what a
								  half-null pair means. `null` on either half is a product that has
								  never been priced, and it reads as an em dash, never `$0.00`,
								  which is a price nobody set.
								*/}
									{formatOptionalAmount(product.priceCents, product.currency)}
								</td>
							</tr>
						);
					})}
				</Table>
			)}

			{/*
			  A FAILED PAGE MOVE RENDERS WHERE THE PAGING BAR WAS, and replaces the
			  whole bar: its controls and this notice would otherwise offer the same
			  request twice, and the one that failed is the one the merchant just
			  pressed. It replaces `Previous`/`Next` as much as `Load more`. The
			  cursor is NOT destroyed to achieve that — see `pageAfterFailure`.
			*/}
			{notice !== null && notice.inline && (
				<div style={{ marginBlockStart: 12 }}>
					<Notice
						variant="error"
						title={notice.title}
						description={notice.description}
						action={retryAction}
						testId="products-load-more-failure"
					/>
				</div>
			)}

			{/*
			  PAGING STOPPED MID-SCAN — rendered where the paging bar was, because it
			  is what replaces every control in it. NO FOCUS MOVE, unlike the seeded-link
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
						testId="products-paging-stopped"
					/>
				</div>
			)}

			{/*
			  THE TWO WAYS FORWARD, IN ONE BAR — and they are two acts, not two
			  spellings of one. `Previous`/`Next` MOVE a one-page window and are how a
			  merchant navigates a long catalog; `Load more` EXTENDS the window and is
			  how they build a low-stock scan to read in one go. Both advance the same
			  position, so the page number below counts either — what differs is
			  whether the rows above stay.
			*/}
			{(pager.visible || loadMoreVisible) && (
				<div
					style={{
						marginBlockStart: 12,
						display: "flex",
						flexWrap: "wrap",
						gap: 12,
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					{pager.visible && (
						<nav
							aria-label={PAGER_LABEL}
							data-testid="products-pager"
							style={{ display: "flex", gap: 8, alignItems: "center" }}
						>
							<PagerButton control={pager.previous} testId="products-prev" onClick={goBack} />
							{pager.position !== undefined && (
								<span
									data-testid="products-page-position"
									// ANNOUNCED, because the one control whose focus survives a
									// page change is the one that caused it: a merchant pressing
									// `Next` from the keyboard keeps focus on the button and would
									// otherwise get no word that anything moved.
									aria-live="polite"
									style={{ fontSize: 13, opacity: 0.75, whiteSpace: "nowrap" }}
								>
									{pager.position}
								</span>
							)}
							<PagerButton
								control={pager.next}
								testId="products-next"
								onClick={() => goForward(false)}
							/>
						</nav>
					)}
					{loadMoreVisible && (
						<button
							type="button"
							className="otta-focusable otta-btn"
							data-testid="products-load-more"
							disabled={busy}
							style={buttonStyle}
							onClick={() => goForward(true)}
						>
							{busy ? "Loading…" : LOAD_MORE_LABEL}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
