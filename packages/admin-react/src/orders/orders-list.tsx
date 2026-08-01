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
	formatAmount,
	formatTimestamp,
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

/** Verbatim from the Block Kit screen — the standing half of the intro line,
 *  with the row count in front of it. */
const LIST_INTRO =
	"Filter, open an order, and move it through its status flow. Money in the order's currency; dates UTC.";

const EMPTY_COLLECTION = {
	title: "No orders yet",
	description: "Orders appear here as buyers check out.",
} as const;

const EMPTY_FILTERED = {
	title: "No orders match these filters",
	description:
		"Nothing came back for the filters you set. Clear them to go back to every order, or widen one and apply again.",
} as const;

/**
 * The count line, and it says only what it can prove.
 *
 * There is no total-count API. A page-1 result with no next cursor IS the whole
 * filtered set, so it can say `17 orders`; anything else can only say how many
 * are on this page. Zero says nothing at all, because the empty state below it
 * is already saying it. Same three cases, same words, as the Block Kit screen.
 */
export function countLine(count: number, firstPage: boolean, hasNext: boolean): string | undefined {
	if (count === 0) return undefined;
	const noun = count === 1 ? "order" : "orders";
	return firstPage && !hasNext
		? `${String(count)} ${noun}`
		: `${String(count)} ${noun} on this page`;
}

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
	readonly vocabulary: Vocabulary;
	readonly firstPage: boolean;
}

export function OrdersList({ onOpen }: { onOpen: (orderId: string) => void }): React.ReactElement {
	const [applied, setApplied] = React.useState<OrdersFilter>({});
	const [draft, setDraft] = React.useState<OrdersFilter>({});
	const [page, setPage] = React.useState<LoadedPage | null>(null);
	const [failure, setFailure] = React.useState<{ title: string; description: string } | null>(null);
	const [busy, setBusy] = React.useState(true);
	// Bumped by "Apply filters" and by "Load more" so a re-fetch is an effect
	// dependency rather than a call scattered through event handlers.
	const [generation, setGeneration] = React.useState(0);
	const [cursor, setCursor] = React.useState<string | undefined>(undefined);

	React.useEffect(() => {
		let cancelled = false;
		setBusy(true);
		void fetchOrders(applied, cursor).then((result) => {
			if (cancelled) return;
			setBusy(false);
			if (isFailure(result)) {
				setFailure({ title: result.title, description: result.description });
				return;
			}
			setFailure(null);
			setPage({
				orders: result.orders,
				nextCursor: result.nextCursor,
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
	const count = countLine(orders.length, page?.firstPage ?? true, page?.nextCursor != null);
	const filtered = parts.length > 0;

	/**
	 * The money column's header states the currency ONCE when every row on the
	 * page shares one (G1), and falls back to a bare `Total` when they do not.
	 * A mixed-currency page cannot state a currency in the header without lying,
	 * and `formatAmount` carries the symbol in every cell either way — so the
	 * header is additional information when it can be, and silent when it cannot.
	 */
	const currencies = new Set(orders.map((o) => o.currency));
	const totalHeader = currencies.size === 1 ? `Total (${[...currencies][0] as string})` : "Total";

	const apply = (next: OrdersFilter) => {
		setApplied(next);
		setDraft(next);
		setCursor(undefined);
		setGeneration((n) => n + 1);
	};

	return (
		<div>
			<h1 style={{ fontSize: 24, fontWeight: 700, marginBlockEnd: 4 }}>Orders</h1>
			<p style={{ fontSize: 13, opacity: 0.75, marginBlockEnd: 16 }} data-testid="orders-intro">
				{count === undefined ? LIST_INTRO : `${count} · ${LIST_INTRO}`}
			</p>

			{failure !== null && (
				<Notice
					variant="error"
					title={failure.title}
					description={failure.description}
					testId="orders-failure"
				/>
			)}

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

					<Field label="Search order ID or buyer email">
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
						label="Apply filters"
						testId="apply-filters"
						onClick={() => apply(normalize(draft, statusAny))}
					/>
				</div>
			</Group>

			{filtered && (
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
					<Button label="Clear filters" testId="clear-filters" onClick={() => apply({})} />
				</section>
			)}

			{busy && page === null && failure === null && (
				<p style={{ fontSize: 13, opacity: 0.7 }} aria-live="polite">
					Loading orders…
				</p>
			)}

			{page !== null && orders.length === 0 && failure === null && (
				<EmptyState
					testId={filtered ? "orders-no-match" : "orders-empty"}
					title={filtered ? EMPTY_FILTERED.title : EMPTY_COLLECTION.title}
					description={filtered ? EMPTY_FILTERED.description : EMPTY_COLLECTION.description}
					{...(filtered ? { action: { label: "Clear filters", onClick: () => apply({}) } } : {})}
				/>
			)}

			{orders.length > 0 && (
				<Table
					testId="orders-table"
					caption="Orders"
					headers={["Placed", "Customer", "Status", "Order #", totalHeader]}
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

			{page?.nextCursor != null && (
				<div style={{ marginBlockStart: 12 }}>
					<button
						type="button"
						className="otta-focusable"
						data-testid="orders-load-more"
						disabled={busy}
						style={buttonStyle}
						onClick={() => setCursor(page.nextCursor ?? undefined)}
					>
						{busy ? "Loading…" : "Load more"}
					</button>
				</div>
			)}
		</div>
	);
}
