/**
 * The React Pricing & inventory list — INC-21, and the second and last screen
 * ADR-0014 migrates.
 *
 * WHAT IS DIFFERENT FROM THE BLOCK KIT SCREEN, and it is the same short list
 * INC-20's Orders list carries, because this is a migration and not a redesign:
 *
 *  - **Row click.** The title cell is a link to the product's detail, with a
 *    full-row hover tint (DESIGNER §8) — never `<tr onClick>`, which would
 *    leave no cell selectable for copy/paste on a screen whose whole second
 *    column is a code an operator pastes into a spreadsheet.
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
 *  - **Filtering stays SERVER-SIDE**, keyset-paged at 25 — except the one
 *    filter that cannot be, and that exception is stated rather than hidden.
 *    "Low stock only" has no service predicate (INC-03 measured one
 *    unconditional join as cheaper than a gated one that walked ~9x the rows),
 *    so it narrows the page this request fetched, `Load more` keeps scanning,
 *    and every sentence around it is page-scoped. The `total` is WITHHELD while
 *    it is on, by the plugin, for the same reason: the service counted a
 *    different set of rows than the ones on screen.
 */
import {
	ABSENT,
	APPLY_FILTERS_LABEL,
	CLEAR_FILTERS_LABEL,
	LOAD_MORE_LABEL,
	LOW_STOCK_FILTER_DESCRIPTION,
	LOW_STOCK_FILTER_LABEL,
	PRODUCTS_EMPTY,
	PRODUCTS_LIST_INTRO,
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
	stockDegradation,
} from "@otta-sh/admin-presentation";
import * as React from "react";
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
	Field,
	Group,
	Notice,
	Table,
	buttonStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";

/** Re-exported so this screen's own modules and its tests name the shared
 *  fallback once, without importing the presentation package for one string. */
export { UNTITLED };

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

interface LoadedPage {
	readonly products: readonly ProductSummary[];
	readonly nextCursor: string | null;
	/** INC-23's exact filtered-set count, when the service reports one AND this
	 *  render is entitled to state it. */
	readonly total: number | undefined;
	readonly stock: StockContext;
	readonly vocabulary: ProductsVocabulary;
	readonly firstPage: boolean;
}

/**
 * Drop the ANSWER from a loaded page while keeping what the page is not (F2).
 *
 * Same rule as the Orders list, and it is the SIMPLER half of it: this screen
 * has no accumulated-pages case to preserve, so every failure clears. The rows,
 * the cursor and the exact count go together — a count without its rows is the
 * same false claim in fewer words, and `12 products · …` over an error notice
 * is the defect F2 names.
 *
 * The VOCABULARY AND THE STOCK CONTEXT SURVIVE, because they are not the
 * answer: they are what the filter panel's two selects are built from, and
 * clearing them would answer a failed load by emptying the controls the
 * operator needs to retry it differently.
 */
export function clearAnswer(page: LoadedPage | null): LoadedPage | null {
	return page === null ? null : { ...page, products: [], nextCursor: null, total: undefined };
}

export function ProductsList({
	onOpen,
}: {
	onOpen: (productId: string) => void;
}): React.ReactElement {
	const [applied, setApplied] = React.useState<ProductsFilter>({});
	const [draft, setDraft] = React.useState<ProductsFilter>({});
	const [page, setPage] = React.useState<LoadedPage | null>(null);
	const [failure, setFailure] = React.useState<{ title: string; description: string } | null>(null);
	const [busy, setBusy] = React.useState(true);
	const [generation, setGeneration] = React.useState(0);
	const [cursor, setCursor] = React.useState<string | undefined>(undefined);

	React.useEffect(() => {
		let cancelled = false;
		setBusy(true);
		void fetchProducts(applied, cursor).then((result) => {
			if (cancelled) return;
			setBusy(false);
			if (isFailure(result)) {
				setFailure({ title: result.title, description: result.description });
				// F2: THE ANSWER GOES WITH THE FAILURE, in the same transition. The
				// table and the count describe a response this render no longer has.
				setPage(clearAnswer);
				return;
			}
			setFailure(null);
			setPage({
				products: result.products,
				nextCursor: result.nextCursor,
				total: result.total,
				stock: result.stock,
				vocabulary: result.vocabulary,
				firstPage: cursor === undefined,
			});
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
	// A "Low stock only" page reports on ITSELF, never on the catalog: the filter
	// narrows the rows this page fetched, so the zero-state wording, the offer to
	// keep looking and the offer to stop are all page-scoped. Same switch the
	// Block Kit screen makes, on the same boolean.
	const narrowed = applied.lowStock === true;

	// THE SHARED DECISION. Same function, same inputs, as the Block Kit screen's
	// `listResult` — so the count line, the wording, and which state renders at
	// all cannot disagree between the two Pricing & inventory screens.
	const outcome = listOutcome({
		count: products.length,
		filtered,
		firstPage: page?.firstPage ?? true,
		hasNext,
		noun: PRODUCTS_NOUN,
		empty: PRODUCTS_EMPTY,
		noMatch: narrowed ? PRODUCTS_LOW_STOCK_NO_MATCH : PRODUCTS_NO_MATCH,
		// The plugin already withheld this while the narrowing was on, so this is
		// simply whatever came through — the decision is made once, where the
		// narrowing happens (`applyLowStockNarrowing`).
		...(page?.total !== undefined ? { total: page.total } : {}),
	});

	// PAGE CONTEXT, NOT ROW DATA: a page narrowed to zero rows still has to be
	// able to say what went wrong, so this is derived from the payload's `stock`
	// rather than from the rows.
	const degraded =
		page === null
			? undefined
			: stockDegradation({
					unreadable: page.stock.unreadable,
					thresholdUnreadable: page.stock.threshold === null,
					filterUnavailable: page.stock.filterUnavailable,
				});

	const apply = (next: ProductsFilter) => {
		setApplied(next);
		setDraft(next);
		setCursor(undefined);
		setGeneration((n) => n + 1);
	};

	return (
		<div>
			<h1 style={{ fontSize: 24, fontWeight: 700, marginBlockEnd: 4 }}>{PRODUCTS_SCREEN_TITLE}</h1>
			<p style={{ fontSize: 13, opacity: 0.75, marginBlockEnd: 16 }} data-testid="products-intro">
				{outcome.countLine === undefined
					? PRODUCTS_LIST_INTRO
					: `${outcome.countLine} · ${PRODUCTS_LIST_INTRO}`}
			</p>

			{failure !== null && (
				<Notice
					variant="error"
					title={failure.title}
					description={failure.description}
					// SAME GENERATION COUNTER, same refusal to clear the failure on the
					// click: the response clears it, so nothing flashes back in the
					// meantime.
					action={{
						label: busy ? RETRYING_LABEL : RETRY_LABEL,
						onClick: () => setGeneration((n) => n + 1),
						disabled: busy,
						busy,
					}}
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

			{filtered && (
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
			{page !== null && outcome.kind === "empty" && failure === null && (
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
			  a page that is not the end of anything. On THIS screen that is the
			  ordinary case rather than the exotic one, because "Low stock only"
			  narrows the fetched page: page 1 of a healthy catalog holds no low-stock
			  rows at all.
			*/}
			{page !== null && outcome.kind === "scan" && failure === null && (
				<p
					data-testid="products-scan-note"
					style={{ fontSize: 13, opacity: 0.8, marginBlockEnd: 12 }}
				>
					{outcome.scanNote}
				</p>
			)}

			{outcome.kind === "rows" && (
				<Table
					testId="products-table"
					caption="Products"
					headers={[
						PRODUCT_COLUMN_LABELS.title,
						PRODUCT_COLUMN_LABELS.sku,
						PRODUCT_COLUMN_LABELS.status,
						PRODUCT_COLUMN_LABELS.onHand,
						PRODUCT_COLUMN_LABELS.price,
					]}
				>
					{products.map((product) => (
						<tr key={product.productId} className="otta-row" data-testid="products-row">
							<td className="otta-td">
								{/*
								  DESIGNER §8: the PRIMARY CELL is the link and the row gets a
								  hover tint. The title is the human handle (M-10) and the first
								  column on the screen being migrated, so it is the cell that
								  opens the record — and the SKU beside it stays plain text,
								  selectable, with its own copy button.
								*/}
								<a
									href={`?product=${encodeURIComponent(product.productId)}`}
									className="otta-focusable"
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
									style={{ color: "inherit" }}
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
										<code data-testid="product-sku">{product.sku}</code>
										<CopyIdButton id={product.sku} testId="copy-sku" what="SKU" />
									</>
								)}
							</td>
							<td className="otta-td">{statusLabel(product)}</td>
							<td className="otta-td otta-num" data-testid="product-on-hand">
								{onHandCell(product.onHand, threshold)}
							</td>
							<td className="otta-td otta-num">
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
					))}
				</Table>
			)}

			{page?.nextCursor != null && (
				<div style={{ marginBlockStart: 12 }}>
					<button
						type="button"
						className="otta-focusable"
						data-testid="products-load-more"
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
