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
	 *
	 * Each bucket ALSO carries `refundedCents` — money that came back on the
	 * orders in it (see {@link PeriodBucket.refundedCents}). The two figures are
	 * a UNION, not a join: a bucket exists when it has revenue **or** refunds, so
	 * a period whose only activity was a full refund is a row with
	 * `revenueCents: 0` rather than no row at all. That is the whole point of
	 * carrying the second figure — a fully refunded order is EXCLUDED from the
	 * revenue allow-list, so before this it left no trace in this report and the
	 * money was reportable nowhere.
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

	/**
	 * SKUs with `on_hand <= threshold`, ascending by `on_hand` (then `sku`).
	 *
	 * Each row carries the LIVE product's `title` via a single LEFT JOIN onto
	 * `product_commerce`, whose ON clause MUST also require `deleted_at IS
	 * NULL`. Sku uniqueness on that table is a PARTIAL unique index over live
	 * rows only, so a soft-deleted product that once held the same sku would
	 * otherwise DUPLICATE the low-stock row (and could win the title). With the
	 * tombstone predicate the join is at most 1:1, and only a live product can
	 * title a row.
	 *
	 * A SECOND, DELIBERATELY DIFFERENT "low stock" lives at
	 * `ProductCommerceStore`'s `ProductListFilter.lowStockThreshold`: this
	 * report is INVENTORY-first (an orphan sku with no live product still
	 * lists here), while that filter is PRODUCT-first (a rowless product is
	 * excluded there). Both are inclusive at the boundary today, so the two
	 * agree there, but they are independent definitions — a future change to
	 * either one's boundary or absent-row rule must update both docs.
	 */
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
	/**
	 * Money REFUNDED against the orders in this bucket — integer minor units in
	 * the same `currency`, and a figure in its own right, never subtracted from
	 * `revenueCents` (the two answer different questions and a merchant needs
	 * both; netting them here would make a refunded sale indistinguishable from
	 * a sale that never happened).
	 *
	 * `0` IS A FACT — "nothing came back in this bucket" — and is emitted as
	 * such. The field is never absent from a bucket; a consumer that must tell
	 * "no refunds" from "this service is too old to report refunds" does it by
	 * the presence of the KEY on the wire, not by a zero.
	 *
	 * THREE DEFINITIONS THAT ARE EASY TO GET WRONG, all deliberate:
	 *
	 *  - **Bucketed by the ORDER's `created_at`, like the revenue beside it** —
	 *    never by the refund's own timestamp. The row therefore reads "orders
	 *    placed in this period took X and gave Y back", which is the only
	 *    reading under which the two figures in one row are comparable, and it
	 *    is the same cohort `ordersByStatus` counts. A cash-flow view (refunds
	 *    ISSUED in the period, whatever they were issued against) is a genuinely
	 *    different report and would need its own endpoint, not this column.
	 *  - **NO state allow-list on the refunded half.** Revenue counts only
	 *    `REVENUE_COUNTING_STATES`; a fully refunded order is `refunded` and
	 *    therefore excluded from that sum. Applying the same allow-list here
	 *    would drop exactly the refunds that matter most and reinstate the gap
	 *    this field closes. Every order in the window contributes its refunds.
	 *  - **FINALIZED refunds only** (`status: 'recorded'` — the
	 *    `sumFinalizedRefunds` set, the same rows the order's refunded badge and
	 *    the `→ refunded` flip are based on). `reserved`/`unverified` rows hold
	 *    ceiling capacity while the gateway leg is unconfirmed or its fate is
	 *    unknown; reporting them as money that came back would state an
	 *    in-flight attempt as a completed fact. `voided` rows released their
	 *    capacity and never moved money. The ACTIVE (non-`voided`) sum is a
	 *    CEILING-arbitration concept, not a reporting one — do not reuse it here.
	 */
	refundedCents: Cents;
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
	/**
	 * The LIVE product's title for this sku, so a low-stock report is readable
	 * without an operator carrying a sku→title map in their head.
	 *
	 * `null` when no live product claims the sku (never synced, soft-deleted,
	 * or the product's own title is null) — and `null` is the ONLY fallback:
	 * the sku must NEVER be substituted as a stand-in title. The sku is already
	 * its own field on this row, so echoing it into `title` would make "the
	 * product is called SKU-42" indistinguishable from "we don't know its
	 * name", and a renderer's `(untitled)` affordance would silently never
	 * fire.
	 */
	title: string | null;
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
