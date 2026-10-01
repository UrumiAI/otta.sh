/**
 * The Products list's Price and Stock columns (ADR-0014, amendment 2026-10-01).
 *
 * EmDash draws the collection's list; each column is a read-only cell per row.
 * Every cell on a page asks for the SAME thing — the price and stock of the
 * page's rows — so they share one request: `summariesFor` memoizes the in-flight
 * read by the page's ids and their `updatedAt`s, which change whenever a row is
 * saved, so a stale page is never served after an edit.
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

/** One page of summaries, shared by every cell rendering that page. */
const inFlight = new Map<string, Promise<Result<ProductSummariesPayload>>>();
/** A list page is ~20–50 rows; a handful of recent pages is plenty to share. */
const KEEP = 8;

function pageKey(items: PricingCellProps["visibleItems"]): string {
	return items.map((i) => `${i.id}@${i.updatedAt ?? ""}`).join("|");
}

export function summariesFor(
	items: PricingCellProps["visibleItems"],
): Promise<Result<ProductSummariesPayload>> {
	const key = pageKey(items);
	const cached = inFlight.get(key);
	if (cached !== undefined) return cached;
	const request = fetchProductSummaries(items.map((i) => i.id));
	inFlight.set(key, request);
	if (inFlight.size > KEEP) {
		const oldest = inFlight.keys().next().value;
		if (oldest !== undefined) inFlight.delete(oldest);
	}
	// A failed read is not kept: the next render may succeed.
	void request.then((result) => {
		if (isFailure(result)) inFlight.delete(key);
	});
	return request;
}

/** Test seam: forget every shared page. */
export function forgetSummaries(): void {
	inFlight.clear();
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
			aria-label={state.status === "failed" ? state.title : "Loading"}
		>
			{state.status === "failed" ? "—" : "…"}
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
				<s aria-label={`Was ${formatAmount(row.compareAtCents, row.currency)}`}>
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
