import type { Cents, Currency } from "../money/cents.js";

/**
 * `ReportingStore` (Phase 7 §4/§6). A READ-ONLY port over the existing
 * orders / order_totals / order_items / inventory tables — it introduces no new
 * write invariant. The port is dialect-agnostic intent only; the SQL (including
 * the dialect-branched period-bucket expression and the revenue-counting state
 * allow-list) lives entirely in the adapter (`store-postgres`), which is what
 * buys the single dialect-parity contract suite this phase's headline test
 * requires.
 *
 * Money in and out is integer minor units (`Cents`): every aggregate SUMs
 * integer `*_cents` columns and returns an integer — no float ever touches a
 * revenue figure. Reports never blend currencies into one number: revenue is
 * always grouped by currency (a single-currency store degenerates to one group).
 */
export interface ReportingStore {
	/**
	 * Revenue bucketed by `interval` and **grouped by currency**, summing the
	 * Phase-6-authoritative `order_totals.total_cents` (net total, joined from
	 * `orders` on `order_id`) for orders whose `state` is in the revenue-counting
	 * allow-list (`REVENUE_COUNTING_STATES`), bucketed on `orders.created_at`.
	 * Ordered by `bucketStart`, then `currency`, for deterministic output.
	 */
	revenueByPeriod(range: DateRange, interval: ReportInterval): Promise<PeriodBucket[]>;

	/**
	 * Count of orders per `orders.state` created in the window. No allow-list —
	 * EVERY state (including `expired`) is a real bucket merchants need. Ordered
	 * by `status` for deterministic output.
	 */
	ordersByStatus(range: DateRange): Promise<StatusCount[]>;

	/**
	 * Top products ranked by `metric` (gross item revenue `quantity ×
	 * unit_price_cents`, or quantity), over the window, using the `order_items`
	 * price/title SNAPSHOT (never a live product join — Phase 4's immutability
	 * rule), filtered by the same revenue-counting allow-list as `revenueByPeriod`,
	 * limited to `limit`.
	 */
	topProducts(range: DateRange, metric: TopProductsMetric, limit: number): Promise<TopProduct[]>;

	/** SKUs with `on_hand <= threshold`, ascending by `on_hand` (then `sku`). */
	lowStock(threshold: number): Promise<LowStockRow[]>;
}

/** Period-bucket granularity for `revenueByPeriod`. */
export type ReportInterval = "day" | "week" | "month";

/** Ranking basis for `topProducts`. */
export type TopProductsMetric = "revenue" | "quantity";

/** Inclusive ISO-8601 UTC window `[from, to]`. */
export interface DateRange {
	from: string;
	to: string;
}

export interface PeriodBucket {
	/** ISO-8601 UTC bucket start (`YYYY-MM-DDT00:00:00.000Z`). */
	bucketStart: string;
	currency: Currency;
	revenueCents: Cents;
}

export interface StatusCount {
	/** The merchant-facing "status" — the adapter reads `orders.state`. */
	status: string;
	orderCount: number;
}

export interface TopProduct {
	productId: string;
	/** The `order_items.title` snapshot at purchase time (never a live title). */
	titleSnapshot: string;
	qtySold: number;
	revenueCents: Cents;
}

export interface LowStockRow {
	sku: string;
	onHand: number;
}

/**
 * The revenue-counting state ALLOW-LIST (Phase 7 §4.2) — realized revenue only:
 * payment confirmed and not reversed. An allow-list, never a "subtract the bad
 * ones" exclusion, so a future new state is excluded by default instead of
 * silently counted. Shared by `revenueByPeriod` and `topProducts` so "revenue"
 * means one thing across the whole report set. Excluded (by omission):
 * `pending`, `failed`, `expired`, `cancelled`, `refunded`.
 */
export const REVENUE_COUNTING_STATES = [
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
] as const;
