/**
 * The Products list's Price and Stock columns (ADR-0014, amendment 2026-10-01).
 *
 * EmDash draws the collection's list; each column is a read-only cell per row.
 * Every cell on a page asks for the SAME thing — the price and stock of the
 * page's rows — so they share one request (`summariesFor`, keyed by the page's
 * ids).
 *
 * FRESHNESS. The key cannot see a commerce edit: a price save or a stock
 * movement changes the commerce row, not the CMS entry's `updatedAt`. So a
 * shared answer is kept only briefly (`FRESH_MS`) — long enough for one page's
 * cells to share it — and the Pricing & stock cards forget every shared page
 * after each of its writes, so returning to the list after an edit reads again.
 */
import * as React from "react";
import { formatAmount } from "@otta-sh/admin-presentation";
import {
	fetchProductSummaries,
	isFailure,
	type ProductPriceStock,
	type ProductSummariesPayload,
	type Result,
} from "../console-api.js";
import { stockStatus } from "./pricing-model.js";
import { usePricingStyles } from "./pricing-styles.js";

/** The part of EmDash's `ContentListColumnCellContext` the cells read. */
export interface PricingCellProps {
	readonly collection: string;
	readonly item: { readonly id: string; readonly updatedAt?: string };
	readonly visibleItems: readonly { readonly id: string; readonly updatedAt?: string }[];
}

/** How long a shared page answer is reused. One render of a page's cells
 *  happens well inside it; an edit elsewhere is never hidden for longer. */
export const FRESH_MS = 10_000;
/** The plugin answers at most this many ids per read. EmDash's list shows 20
 *  per page; a larger page is split rather than refused. */
const BATCH = 100;

type Shared = { readonly at: number; readonly request: Promise<Result<ProductSummariesPayload>> };
const shared = new Map<string, Shared>();

function pageKey(items: PricingCellProps["visibleItems"]): string {
	return items.map((i) => `${i.id}@${i.updatedAt ?? ""}`).join("|");
}

async function readPage(ids: readonly string[]): Promise<Result<ProductSummariesPayload>> {
	const batches: string[][] = [];
	for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
	const answers = await Promise.all(batches.map((batch) => fetchProductSummaries(batch)));
	const failed = answers.find(isFailure);
	if (failed !== undefined) return failed;
	const ok = answers as ProductSummariesPayload[];
	return {
		ok: true,
		products: ok.flatMap((a) => a.products),
		threshold: ok[0]?.threshold ?? null,
	};
}

export function summariesFor(
	items: PricingCellProps["visibleItems"],
	now: number = Date.now(),
): Promise<Result<ProductSummariesPayload>> {
	const key = pageKey(items);
	const hit = shared.get(key);
	if (hit !== undefined && now - hit.at < FRESH_MS) return hit.request;
	for (const [k, v] of shared) if (now - v.at >= FRESH_MS) shared.delete(k);
	const request = readPage(items.map((i) => i.id));
	shared.set(key, { at: now, request });
	// A failed read is not shared: the next render may succeed.
	void request.then((result) => {
		if (isFailure(result)) shared.delete(key);
	});
	return request;
}

/** Forget every shared page — after a panel write, so the list reads again. */
export function forgetSummaries(): void {
	shared.clear();
}

type CellState =
	| { readonly status: "loading" }
	| { readonly status: "failed"; readonly title: string }
	| {
			readonly status: "ready";
			readonly row: ProductPriceStock | null;
			readonly threshold: number | null;
	  };

function useRow({ item, visibleItems }: PricingCellProps): CellState {
	usePricingStyles();
	const [state, setState] = React.useState<CellState>({ status: "loading" });
	// `visibleItems` is a new array every render; the page KEY is what changes
	// when the page does, so it is the effect's dependency and the array is read
	// through a ref.
	const key = pageKey(visibleItems);
	const items = React.useRef(visibleItems);
	items.current = visibleItems;
	React.useEffect(() => {
		let cancelled = false;
		void summariesFor(items.current).then((result) => {
			if (cancelled) return;
			if (isFailure(result)) {
				setState({ status: "failed", title: result.title });
				return;
			}
			setState({
				status: "ready",
				row: result.products.find((p) => p.productId === item.id) ?? null,
				threshold: result.threshold,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [key, item.id]);
	return state;
}

function Pending({ state }: { state: CellState }): React.ReactElement {
	return (
		<span
			className="otta-pricing-cell otta-pricing-cell-muted"
			title={state.status === "failed" ? state.title : undefined}
		>
			<span aria-hidden="true">{state.status === "failed" ? "—" : "…"}</span>
			<span className="otta-sr-only">
				{state.status === "failed" ? state.title : "Loading price and stock"}
			</span>
		</span>
	);
}

export function PriceCell(props: PricingCellProps): React.ReactElement {
	const state = useRow(props);
	if (state.status !== "ready") return <Pending state={state} />;
	const row = state.row;
	if (row === null || row.priceCents === null || row.currency === null) {
		return <span className="otta-pricing-cell otta-pricing-cell-muted">Not priced</span>;
	}
	return (
		<span className="otta-pricing-cell">
			<span>{formatAmount(row.priceCents, row.currency)}</span>
			{row.compareAtCents !== null && row.compareAtCents > row.priceCents && (
				<s>
					<span className="otta-sr-only">was </span>
					{formatAmount(row.compareAtCents, row.currency)}
				</s>
			)}
		</span>
	);
}

export function StockCell(props: PricingCellProps): React.ReactElement {
	const state = useRow(props);
	if (state.status !== "ready") return <Pending state={state} />;
	const row = state.row;
	let body: React.ReactElement;
	if (row === null || row.sku === null) {
		body = <span className="otta-pricing-cell-muted">No SKU yet</span>;
	} else {
		const status = stockStatus(row.onHand, state.threshold);
		const text =
			row.onHand === null
				? status.label
				: row.onHand <= 0
					? "Out of stock"
					: `${String(row.onHand)} in stock${status.tone === "warn" ? " · low" : ""}`;
		body = (
			<span className="otta-pricing-cell-stock">
				<span className="otta-pricing-dot" data-tone={status.tone} aria-hidden="true" />
				<span className="otta-pricing-num">{text}</span>
			</span>
		);
	}
	return (
		<span className="otta-pricing-cell" data-align="start">
			{body}
		</span>
	);
}

/** The columns EmDash discovers on the admin module (`contentListColumns`).
 *  Admin-only for the same reason as the panel: the route behind them is. */
export const PRICING_COLUMNS = [
	{
		id: "price",
		label: "Price",
		cell: PriceCell,
		collections: ["products"],
		minRole: 50,
		order: 10,
		align: "end",
	},
	{
		id: "stock",
		label: "Stock",
		cell: StockCell,
		collections: ["products"],
		minRole: 50,
		order: 20,
	},
] as const;
