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
	PRODUCTS_EMPTY,
	PRODUCTS_LIST_INTRO,
	PRODUCTS_LOAD_MORE_FAILED_TITLE,
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
import { continuationCursor, mergeById, type PendingCursor } from "../accumulate.js";
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
 * filter keeps only the low-stock rows out of each page as it arrives, so page
 * one's matches vanished at the exact moment the merchant asked to see more of
 * them.
 *
 * A CONTINUATION EXTENDS; EVERYTHING ELSE RESETS. `continuation` is "this
 * request carried a cursor", which is exactly the request `Load more` (and a
 * Retry of it) issues. A filter change clears the cursor before re-fetching, so
 * it arrives here as a reset and the previous filter's rows go — and a first
 * mount, including one deep-linked to a filtered address, is the same reset.
 *
 * THE CURSOR, THE TOTAL, THE STOCK CONTEXT AND THE VOCABULARY TAKE THE NEW
 * PAGE'S VALUES; the rows merge by id (see {@link mergeById}) and `firstPage` is
 * inherited, because a scan that began at the first page still starts there
 * after its second page lands.
 */
export function nextPage(
	current: LoadedPage | null,
	incoming: ProductsResponse,
	continuation: boolean,
): LoadedPage {
	if (!continuation) return { ...incoming, firstPage: true, pages: 1 };
	if (current === null) return { ...incoming, firstPage: false, pages: 1 };
	return {
		...incoming,
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
 * out there. It is reachable on the flagship path, because the service withholds
 * the total precisely while "Low stock only" is on. Worse at zero rows: a page
 * narrowed to nothing with a cursor behind it turned from a scan note with
 * paging still offered into an empty state offering `Clear filters`, dead-ending
 * the scan.
 *
 * SO THE CONTROL IS GUARDED INSTEAD OF THE STATE DESTROYED. `Load more` renders
 * on `there is no failure` as well as on the cursor, so it does not stand beside
 * a notice already carrying the Retry for the same request; the retry re-runs
 * from the cursor the page kept, and its response merges onto the rows that
 * stayed. Same shape as the Orders list, which had it right.
 */
export function pageAfterFailure(
	page: LoadedPage | null,
	continuation: boolean,
): LoadedPage | null {
	return continuation ? page : clearAnswer(page);
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
 *  - A CONTINUATION failure is about ONE REQUEST, and the rows above it are the
 *    answer to a different one that succeeded. Rendering the service's
 *    whole-collection refusal over rows that are still on screen states
 *    something those rows disprove, so the title shrinks to the claim this
 *    render can back — the NEXT page failed — and it is drawn inline, where
 *    `Load more` was, because that is the control it replaces.
 */
export function failureNotice(
	failure: {
		readonly title: string;
		readonly description: string;
		readonly continuation: boolean;
	} | null,
): { readonly title: string; readonly description: string; readonly inline: boolean } | null {
	if (failure === null) return null;
	return failure.continuation
		? { title: PRODUCTS_LOAD_MORE_FAILED_TITLE, description: failure.description, inline: true }
		: { title: failure.title, description: failure.description, inline: false };
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
	onFilterChange,
}: {
	onOpen: (productId: string) => void;
	/** The filter the address bar arrived with (F22). BOTH the applied filter and
	 *  the draft are seeded from it, so a shared link lands filtered AND the panel
	 *  shows why, rather than reading as an unfiltered catalog that mysteriously
	 *  holds four rows. */
	initialFilter?: ProductsFilter;
	/** Announced whenever the applied filter changes, for the screen to write to
	 *  the URL. The list never touches history itself: one writer. */
	onFilterChange?: (filter: ProductsFilter) => void;
}): React.ReactElement {
	const [applied, setApplied] = React.useState<ProductsFilter>(initialFilter);
	const [draft, setDraft] = React.useState<ProductsFilter>(initialFilter);
	const [page, setPage] = React.useState<LoadedPage | null>(null);
	/** `continuation` records WHICH request failed — a first page, or a page
	 *  behind one that already succeeded — because that is what decides whether
	 *  the rows on screen are disproved by the failure or untouched by it. */
	const [failure, setFailure] = React.useState<{
		title: string;
		description: string;
		continuation: boolean;
	} | null>(null);
	const [busy, setBusy] = React.useState(true);
	// The Retry's OWN in-flight state. `busy` is the whole screen's, and the
	// filter panel stays interactive under a failure notice, so driving the Retry
	// from `busy` would make an "Apply filters" the operator pressed read back as
	// "Retrying…" on a request they never issued.
	const [retrying, setRetrying] = React.useState(false);
	// Bumped by "Apply filters" and by Retry. `Load more` re-runs this effect
	// through the cursor it sets, which is a fresh object on every click, so a
	// service that repeats a cursor VALUE still gets a request.
	const [generation, setGeneration] = React.useState(0);
	const [cursor, setCursor] = React.useState<PendingCursor<ProductsFilter> | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		// A CURSOR IS ONLY A CONTINUATION OF ITS OWN FILTER (see
		// `continuationCursor`): one belonging to a filter that has since been
		// replaced is not sent, and this request is the new filter's first page.
		const from = continuationCursor(cursor, applied);
		const continuation = from !== undefined;
		setBusy(true);
		void fetchProducts(applied, from).then((result) => {
			if (cancelled) return;
			setBusy(false);
			// Whatever the outcome, the click that asked for this is over.
			setRetrying(false);
			if (isFailure(result)) {
				setFailure({ title: result.title, description: result.description, continuation });
				// F2: THE ANSWER GOES WITH THE FAILURE, in the same transition — for a
				// FIRST page. A page behind one that succeeded takes only its own
				// cursor with it (F24); see `pageAfterFailure`.
				setPage((current) => pageAfterFailure(current, continuation));
				return;
			}
			setFailure(null);
			// F24: MERGE, NEVER ASSIGN. The functional form is required, not
			// stylistic: the rows it merges into are the ones in state at the moment
			// the response lands.
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
					continuation,
				),
			);
		});
		return () => {
			cancelled = true;
		};
	}, [applied, cursor, generation]);

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
		noMatch: narrowed ? PRODUCTS_LOW_STOCK_NO_MATCH : PRODUCTS_NO_MATCH,
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
	const answerVisible = failure === null || failure.continuation;
	const degraded = visibleDegradation(page, !answerVisible);
	// F3: a cold failure has no vocabulary to build the two selects from, so the
	// panel goes with the answer rather than standing there empty.
	const showFilters = filtersVisible(page, failure !== null);
	// WHICH OF THE TWO PLACES THE FAILURE IS DRAWN IN — see `failureNotice`.
	const notice = failureNotice(failure);

	// THE FAILURE IS NOT CLEARED ON THE CLICK. Clearing it here rather than on the
	// response would flash the stale answer back for the length of the request.
	const retryAction = {
		label: retrying ? RETRYING_LABEL : RETRY_LABEL,
		onClick: () => {
			setRetrying(true);
			setGeneration((n) => n + 1);
		},
		disabled: retrying,
		busy: retrying,
	};

	const apply = (next: ProductsFilter) => {
		setApplied(next);
		setDraft(next);
		setCursor(null);
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
			<p style={{ fontSize: 13, opacity: 0.75, marginBlockEnd: 16 }} data-testid="products-intro">
				{outcome.countLine === undefined
					? PRODUCTS_LIST_INTRO
					: `${outcome.countLine} · ${PRODUCTS_LIST_INTRO}`}
			</p>

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

					<div style={{ marginBlockStart: 12 }}>
						<Button
							label={APPLY_FILTERS_LABEL}
							testId="apply-filters"
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

			  KEPT AS A GUARD, NOT AS A CASE. "Low stock only" is a predicate the
			  SERVICE applies across the whole catalog, so a page that comes back
			  empty is the end of the filtered set and carries no cursor — the store
			  emits one only when a page overflows its limit. This branch was the
			  ORDINARY case while the filter narrowed an already-fetched page, and
			  it is unreachable now; it stays because the cost of being wrong about
			  that is burying the operator's only way forward.
			*/}
			{page !== null && outcome.kind === "scan" && answerVisible && (
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
			  THE CONTINUATION FAILURE RENDERS WHERE `Load more` WAS, and replaces
			  it: the button and the notice would otherwise offer the same request
			  twice, and the one that failed is the one the merchant just pressed.
			  The cursor is NOT destroyed to achieve that — see `pageAfterFailure`.
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

			{page?.nextCursor != null && failure === null && (
				<div style={{ marginBlockStart: 12 }}>
					<button
						type="button"
						className="otta-focusable otta-btn"
						data-testid="products-load-more"
						disabled={busy}
						style={buttonStyle}
						onClick={() => {
							const value = page.nextCursor;
							if (value !== null) setCursor({ filter: applied, value });
						}}
					>
						{busy ? "Loading…" : LOAD_MORE_LABEL}
					</button>
				</div>
			)}
		</div>
	);
}
