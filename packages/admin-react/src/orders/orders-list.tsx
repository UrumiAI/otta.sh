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
	formatAmount,
	formatTimestamp,
	listOutcome,
	orderStateCell,
	shortIdFixed,
	shortIdsFor,
} from "@otta-sh/admin-presentation";
import * as React from "react";
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
	Field,
	Group,
	Notice,
	Table,
	buttonStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";

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

interface LoadedPage {
	readonly orders: readonly OrderSummary[];
	readonly nextCursor: string | null;
	/** INC-23's exact filtered-set count, when the service reports one. */
	readonly total: number | undefined;
	readonly vocabulary: Vocabulary;
	readonly firstPage: boolean;
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

export function OrdersList({ onOpen }: { onOpen: (orderId: string) => void }): React.ReactElement {
	const [applied, setApplied] = React.useState<OrdersFilter>({});
	const [draft, setDraft] = React.useState<OrdersFilter>({});
	const [page, setPage] = React.useState<LoadedPage | null>(null);
	const [failure, setFailure] = React.useState<OrdersFailure | null>(null);
	const [busy, setBusy] = React.useState(true);
	// Bumped by "Apply filters", by "Load more" and by Retry, so a re-fetch is an
	// effect dependency rather than a call scattered through event handlers.
	// RETRY IS THE WHOLE OF THE MECHANISM: same filter, same cursor, one integer.
	const [generation, setGeneration] = React.useState(0);
	const [cursor, setCursor] = React.useState<string | undefined>(undefined);

	React.useEffect(() => {
		let cancelled = false;
		const continuation = cursor !== undefined;
		setBusy(true);
		void fetchOrders(applied, cursor).then((result) => {
			if (cancelled) return;
			setBusy(false);
			if (isFailure(result)) {
				setFailure({ title: result.title, description: result.description, continuation });
				// A FIRST PAGE THAT FAILED DISPROVES WHAT IS ON SCREEN; a page behind
				// one that succeeded does not. Only the first case clears.
				if (!continuation) setPage(clearAnswer);
				return;
			}
			setFailure(null);
			setPage({
				orders: result.orders,
				nextCursor: result.nextCursor,
				total: result.total,
				vocabulary: result.vocabulary,
				firstPage: cursor === undefined,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [applied, cursor, generation]);

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
		noun: ORDERS_NOUN,
		empty: ORDERS_EMPTY,
		noMatch: ORDERS_NO_MATCH,
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
		setCursor(undefined);
		setGeneration((n) => n + 1);
	};

	// ONE GUARD, USED BY EVERY BRANCH THAT STATES SOMETHING ABOUT THE ANSWER —
	// the table, the count line, the zero states and `Load more`. The bug F1
	// names is that the table rendered under `outcome.kind === "rows"` while its
	// two sibling branches also checked `failure === null`, so a failure the
	// count and the notice both acknowledged left the rows standing.
	const card = failure === null ? null : ordersFailureCard(failure, page !== null);
	const answerVisible = card === null || card.answerVisible;
	const filtersVisible = card === null ? page !== null : card.filtersVisible;

	// THE FAILURE IS NOT CLEARED HERE. Clearing it on the click rather than on
	// the response would flash the stale answer back for the length of the
	// request — the exact defect being fixed. The response clears it.
	const retryAction = (): {
		label: string;
		onClick: () => void;
		disabled: boolean;
		busy: boolean;
		autoFocus: boolean;
	} => ({
		label: busy ? RETRYING_LABEL : RETRY_LABEL,
		onClick: () => setGeneration((n) => n + 1),
		disabled: busy,
		busy,
		autoFocus: card?.focusRetry === true,
	});

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
					action={retryAction()}
					testId="orders-failure"
				/>
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
			  with the button that is still there, and the button still is.
			*/}
			{page !== null && outcome.kind === "scan" && answerVisible && (
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
					headers={["Placed", "Customer", "Status", "Order #", "Total"]}
				>
					{orders.map((order) => {
						const prefix = shortIds.get(order.id) ?? shortIdFixed(order.id);
						return (
							<tr key={order.id} className="otta-row" data-testid="orders-row">
								<td className="otta-td otta-num">{formatTimestamp(order.createdAt)}</td>
								<td className="otta-td">{order.customerId ?? order.buyerRef}</td>
								<td className="otta-td">{orderStateCell(order.state)}</td>
								<td className="otta-td" style={{ whiteSpace: "nowrap" }}>
									{/*
									  DESIGNER §8: the PRIMARY CELL is the link and the row gets a
									  hover tint — never `<tr onClick>`. A whole-row target invites
									  double-clicks and leaves no cell selectable for copy/paste,
									  which order ops need constantly. The identity cell is the one
									  that opens the record, and the copy button sits beside it so
									  §1.3's two halves — prefix on screen, full id in the clipboard
									  — are one affordance in one place.
									*/}
									<a
										href={`?order=${encodeURIComponent(order.id)}`}
										className="otta-focusable"
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
										style={{ color: "inherit", fontFamily: "ui-monospace, monospace" }}
									>
										{prefix}
									</a>
									<CopyIdButton id={order.id} testId="copy-order-id" />
								</td>
								<td className="otta-td otta-num">
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
						action={retryAction()}
						testId="orders-load-more-failure"
					/>
				</div>
			)}

			{page?.nextCursor != null && failure === null && (
				<div style={{ marginBlockStart: 12 }}>
					<button
						type="button"
						className="otta-focusable"
						data-testid="orders-load-more"
						disabled={busy}
						style={buttonStyle}
						onClick={() => setCursor(page.nextCursor ?? undefined)}
					>
						{busy ? "Loading…" : LOAD_MORE_LABEL}
					</button>
				</div>
			)}
		</div>
	);
}
