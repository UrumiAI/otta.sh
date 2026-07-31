import type {
	SeedInventoryRow,
	SeedOrderItemRow,
	SeedOrderRow,
	SeedProductTitleRow,
} from "./in-memory-reporting-store.js";

/**
 * Deterministic reporting fixture (Phase 7 §4.3) — the SINGLE source of truth
 * shared by the in-memory-fake use-case tests AND the dialect seeded-aggregate
 * test, so what's "designed" and what's "seeded" can never drift.
 *
 * 14 orders across 3 UTC days and 2 currencies, with **every one of the ten
 * Phase-4/5 order states represented at least once** so the revenue allow-list
 * (`paid`/`processing`/`shipped`/`delivered`/`completed`) is proven against every
 * excluded state — `pending`/`failed`/`expired`/`cancelled`/`refunded`. The
 * hand-computed revenue (`EXPECTED_TOTAL_REVENUE`) differs from both "sum
 * everything" and "sum excluding only cancelled/refunded", so a correct allow-list
 * is distinguishable from the old, wrong exclusion-list. 4 products with known
 * per-line qty/price feed top-products (with items on two EXCLUDED orders to prove
 * they never count), and inventory rows straddle the low-stock threshold.
 */

export const REPORTING_WINDOW = {
	from: "2026-07-10T00:00:00.000Z",
	to: "2026-07-12T23:59:59.999Z",
} as const;

export const FIXTURE_ORDERS: SeedOrderRow[] = [
	// -- 2026-07-10 --------------------------------------------------------------
	{
		id: "o1",
		state: "paid",
		currency: "USD",
		createdAt: "2026-07-10T01:00:00.000Z",
		totalCents: 1000,
	},
	{
		id: "o2",
		state: "processing",
		currency: "USD",
		createdAt: "2026-07-10T05:00:00.000Z",
		totalCents: 2000,
	},
	{
		id: "o3",
		state: "pending",
		currency: "USD",
		createdAt: "2026-07-10T06:00:00.000Z",
		totalCents: 9999,
	},
	{
		id: "o4",
		state: "paid",
		currency: "EUR",
		createdAt: "2026-07-10T08:00:00.000Z",
		totalCents: 3000,
	},
	// -- 2026-07-11 --------------------------------------------------------------
	{
		id: "o5",
		state: "shipped",
		currency: "USD",
		createdAt: "2026-07-11T02:00:00.000Z",
		totalCents: 1500,
	},
	{
		id: "o6",
		state: "delivered",
		currency: "EUR",
		createdAt: "2026-07-11T03:00:00.000Z",
		totalCents: 2500,
	},
	{
		id: "o7",
		state: "failed",
		currency: "USD",
		createdAt: "2026-07-11T04:00:00.000Z",
		totalCents: 8888,
	},
	{
		id: "o8",
		state: "cancelled",
		currency: "EUR",
		createdAt: "2026-07-11T05:00:00.000Z",
		totalCents: 7777,
	},
	{
		id: "o9",
		state: "completed",
		currency: "USD",
		createdAt: "2026-07-11T06:00:00.000Z",
		totalCents: 4000,
	},
	// -- 2026-07-12 --------------------------------------------------------------
	{
		id: "o10",
		state: "refunded",
		currency: "USD",
		createdAt: "2026-07-12T01:00:00.000Z",
		totalCents: 6666,
	},
	{
		id: "o11",
		state: "expired",
		currency: "EUR",
		createdAt: "2026-07-12T02:00:00.000Z",
		totalCents: 5555,
	},
	{
		id: "o12",
		state: "paid",
		currency: "EUR",
		createdAt: "2026-07-12T03:00:00.000Z",
		totalCents: 3500,
	},
	{
		id: "o13",
		state: "processing",
		currency: "USD",
		createdAt: "2026-07-12T04:00:00.000Z",
		totalCents: 2200,
	},
	{
		id: "o14",
		state: "shipped",
		currency: "USD",
		createdAt: "2026-07-12T05:00:00.000Z",
		totalCents: 800,
	},
];

export const FIXTURE_ITEMS: SeedOrderItemRow[] = [
	// counting orders
	{ orderId: "o1", productId: "p1", title: "Widget", unitPriceCents: 500, quantity: 2 },
	{ orderId: "o1", productId: "p2", title: "Gadget", unitPriceCents: 1000, quantity: 1 },
	{ orderId: "o2", productId: "p1", title: "Widget", unitPriceCents: 500, quantity: 1 },
	{ orderId: "o4", productId: "p3", title: "Gizmo", unitPriceCents: 250, quantity: 4 },
	{ orderId: "o5", productId: "p2", title: "Gadget", unitPriceCents: 1000, quantity: 2 },
	{ orderId: "o6", productId: "p4", title: "Doohickey", unitPriceCents: 2000, quantity: 1 },
	{ orderId: "o9", productId: "p1", title: "Widget", unitPriceCents: 500, quantity: 3 },
	{ orderId: "o9", productId: "p4", title: "Doohickey", unitPriceCents: 2000, quantity: 1 },
	{ orderId: "o12", productId: "p3", title: "Gizmo", unitPriceCents: 250, quantity: 2 },
	{ orderId: "o13", productId: "p2", title: "Gadget", unitPriceCents: 1000, quantity: 1 },
	{ orderId: "o14", productId: "p1", title: "Widget", unitPriceCents: 500, quantity: 1 },
	// EXCLUDED orders carry items too — must never count toward top-products.
	{ orderId: "o3", productId: "p4", title: "Doohickey", unitPriceCents: 2000, quantity: 10 },
	{ orderId: "o8", productId: "p1", title: "Widget", unitPriceCents: 500, quantity: 50 },
];

export const FIXTURE_INVENTORY: SeedInventoryRow[] = [
	{ sku: "SKU-A", onHand: 0 },
	{ sku: "SKU-B", onHand: 3 },
	{ sku: "SKU-C", onHand: 5 },
	{ sku: "SKU-D", onHand: 8 },
	{ sku: "SKU-E", onHand: 5 },
];

/**
 * `product_commerce` rows behind the low-stock SKUs, built so every branch of
 * `lowStock`'s title join is exercised by the shared fixture:
 *
 *  - `SKU-A` — a plain live product: its title lands on the row.
 *  - `SKU-B` — a live product whose OWN title is null: `title: null`.
 *  - `SKU-C` — the TOMBSTONE-COLLISION case: one live row plus a soft-deleted
 *    row holding the SAME sku (legal — live-sku uniqueness is a partial index,
 *    so a soft delete releases the sku). The row must appear exactly ONCE and
 *    carry the LIVE title, never the tombstone's.
 *  - `SKU-E` — ONLY a tombstone claims it: the row still appears (inventory is
 *    the driving table) with `title: null`, never the sku.
 *  - `SKU-D` — above the threshold, so it never reaches a low-stock assertion.
 */
export const FIXTURE_PRODUCT_TITLES: SeedProductTitleRow[] = [
	{ sku: "SKU-A", title: "Alpha Widget" },
	{ sku: "SKU-B", title: null },
	{ sku: "SKU-C", title: "Gamma Sprocket" },
	{ sku: "SKU-C", title: "Gamma Sprocket (old)", deletedAt: "2026-07-01T00:00:00.000Z" },
	{ sku: "SKU-D", title: "Delta Gizmo" },
	{ sku: "SKU-E", title: "Epsilon Ghost", deletedAt: "2026-07-02T00:00:00.000Z" },
];

/** Σ total_cents over ONLY the five revenue-counting states (hand-computed). */
export const EXPECTED_TOTAL_REVENUE = 20_500;
/** Σ over every order — must differ from the allow-list sum. */
export const EXPECTED_SUM_ALL = 59_385;
/** Σ over everything except cancelled+refunded — the OLD wrong logic; must also
 *  differ from the allow-list sum (still counts pending/failed/expired). */
export const EXPECTED_SUM_EXCLUDING_CANCELLED_REFUNDED = 44_942;

/** revenueByPeriod(day) expected buckets, ordered by bucketStart then currency. */
export const EXPECTED_REVENUE_BY_DAY = [
	{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "EUR", revenueCents: 3000 },
	{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "USD", revenueCents: 3000 },
	{ bucketStart: "2026-07-11T00:00:00.000Z", currency: "EUR", revenueCents: 2500 },
	{ bucketStart: "2026-07-11T00:00:00.000Z", currency: "USD", revenueCents: 5500 },
	{ bucketStart: "2026-07-12T00:00:00.000Z", currency: "EUR", revenueCents: 3500 },
	{ bucketStart: "2026-07-12T00:00:00.000Z", currency: "USD", revenueCents: 3000 },
];

/** ordersByStatus expected counts, ordered by status. */
export const EXPECTED_ORDERS_BY_STATUS = [
	{ status: "cancelled", orderCount: 1 },
	{ status: "completed", orderCount: 1 },
	{ status: "delivered", orderCount: 1 },
	{ status: "expired", orderCount: 1 },
	{ status: "failed", orderCount: 1 },
	{ status: "paid", orderCount: 3 },
	{ status: "pending", orderCount: 1 },
	{ status: "processing", orderCount: 2 },
	{ status: "refunded", orderCount: 1 },
	{ status: "shipped", orderCount: 2 },
];

/** top-products by revenue (gross item revenue), full window. p2 & p4 tie at
 *  4000 → productId asc breaks it (p2 before p4). */
export const EXPECTED_TOP_BY_REVENUE = [
	{ productId: "p2", titleSnapshot: "Gadget", qtySold: 4, revenueCents: 4000 },
	{ productId: "p4", titleSnapshot: "Doohickey", qtySold: 2, revenueCents: 4000 },
	{ productId: "p1", titleSnapshot: "Widget", qtySold: 7, revenueCents: 3500 },
	{ productId: "p3", titleSnapshot: "Gizmo", qtySold: 6, revenueCents: 1500 },
];

/** top-products by quantity, full window. */
export const EXPECTED_TOP_BY_QUANTITY = [
	{ productId: "p1", titleSnapshot: "Widget", qtySold: 7, revenueCents: 3500 },
	{ productId: "p3", titleSnapshot: "Gizmo", qtySold: 6, revenueCents: 1500 },
	{ productId: "p2", titleSnapshot: "Gadget", qtySold: 4, revenueCents: 4000 },
	{ productId: "p4", titleSnapshot: "Doohickey", qtySold: 2, revenueCents: 4000 },
];
