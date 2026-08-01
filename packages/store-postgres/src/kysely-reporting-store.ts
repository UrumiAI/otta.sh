import {
	cents,
	currency as toCurrency,
	type DateRange,
	type LowStockRow,
	type PeriodBucket,
	type ReportInterval,
	type ReportingStore,
	REVENUE_COUNTING_STATES,
	type StatusCount,
	type TopProduct,
	type TopProductsMetric,
} from "@otta-sh/domain";
import { type Kysely, type RawBuilder, sql } from "kysely";
import type { Database } from "./schema.js";

export type ReportingDialect = "sqlite" | "postgres";

export interface KyselyReportingStoreOptions {
	db: Kysely<Database>;
	/** The single piece of dialect knowledge this phase needs — the period-bucket
	 *  expression branches on it (§4.2); everything else is portable SQL. */
	dialect: ReportingDialect;
}

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Convert a SQL aggregate (`SUM`/`COUNT`) to a JS integer WITHOUT silent
 * precision loss. Postgres returns `SUM(int)`/`COUNT(*)` as a bigint/numeric
 * STRING; a naive `Number("9007199254740993")` would round to a nearby safe
 * integer that `cents()` then happily accepts. Range-check via BigInt FIRST so an
 * out-of-safe-range aggregate THROWS rather than coercing. SQLite returns a
 * number directly; assert it's a safe integer (guards the dynamic-typing float
 * footgun too). Exported for a focused unit test (an actual >2^53 sum would need
 * millions of rows to reproduce end-to-end).
 */
export function parseAggregate(raw: number | string): number {
	if (typeof raw === "number") {
		if (!Number.isSafeInteger(raw)) {
			throw new RangeError(`reporting aggregate ${String(raw)} is not a safe integer`);
		}
		return raw;
	}
	const big = BigInt(raw);
	if (big > MAX_SAFE_BIG || big < -MAX_SAFE_BIG) {
		throw new RangeError(
			`reporting aggregate ${raw} exceeds Number.MAX_SAFE_INTEGER — refusing to coerce`,
		);
	}
	return Number(big);
}

/** The revenue-counting state allow-list as a parameterized SQL `IN (…)` list —
 *  built ONCE from the domain constant so both revenue and top-products share it
 *  (never reimplemented, never drifts). */
const REVENUE_STATES_IN: RawBuilder<unknown> = sql`(${sql.join(
	REVENUE_COUNTING_STATES.map((s) => sql.val(s)),
)})`;

/** The ONE `refunds.status` that is money which actually came back — the
 *  `sumFinalizedRefunds` set (`PeriodBucket.refundedCents`). Deliberately an
 *  equality against the finalized state rather than `<> 'voided'`: the ACTIVE
 *  (non-voided) set is the CEILING's arbitration rule, and reusing it here would
 *  report a `reserved`/`unverified` attempt as a completed refund. */
const FINALIZED_REFUND_STATUS = "recorded";

/**
 * `ReportingStore` over Kysely (§4.2), read-only over the existing orders /
 * order_totals / order_items / inventory tables. Money and quantity columns are
 * integers on both dialects, so `SUM()`/`COUNT()` stay integers; pg returns those
 * aggregates as strings (bigint/numeric) which `cents()` re-validates as safe
 * integers. The ONLY dialect-specific SQL is the period-bucket expression
 * (`#bucketSql`); the port and contract assertions are dialect-agnostic.
 */
export class KyselyReportingStore implements ReportingStore {
	readonly #db: Kysely<Database>;
	readonly #dialect: ReportingDialect;

	constructor(options: KyselyReportingStoreOptions) {
		this.#db = options.db;
		this.#dialect = options.dialect;
	}

	/**
	 * Revenue AND refunds per (bucket, currency) in ONE statement (port doc).
	 *
	 * The shape is a `UNION ALL` of two contribution sets folded by a single
	 * `GROUP BY`, which is a deliberate choice over both a JOIN and two round
	 * trips:
	 *  - the two halves have DIFFERENT predicates (revenue applies the state
	 *    allow-list, refunds apply none and filter the ledger lifecycle instead),
	 *    so neither can be expressed as a filter on the other's rows;
	 *  - a bucket must exist when EITHER half contributes — a fully refunded
	 *    order is excluded from revenue, so an inner join would drop exactly the
	 *    row that field was added for, and `FULL OUTER JOIN` is the one join shape
	 *    better-sqlite3 did not carry until 3.39. The union is portable, needs no
	 *    dialect branch of its own, and yields the outer-join semantics for free.
	 *
	 * Both halves alias `orders` as `o`, so the ONE dialect-branched fragment
	 * (`#bucketSql`, which reads `o.created_at`) is shared verbatim — the refund's
	 * own timestamp is never the bucket key (port doc).
	 *
	 * MEASURED (pg 16, 5,000 orders over ~208 day buckets in 2 currencies, 417
	 * refund rows, 60 runs after 10 warm-ups) against the single-scan shape this
	 * replaced:
	 *   old (revenue only)  p50 10.87 ms · p95 13.99 ms
	 *   new (UNION ALL)     p50 13.30 ms · p95 15.52 ms   — +2.4 ms p50, ~22%
	 * The second branch scans a table two orders of magnitude smaller than
	 * `orders`, so the added cost tracks the REFUND count, not the order count.
	 * No index was added: the refunds side is driven from `orders` through the
	 * existing `refunds(order_id, created_at, id)` composite (migration 0020).
	 */
	async revenueByPeriod(range: DateRange, interval: ReportInterval): Promise<PeriodBucket[]> {
		const bucket = this.#bucketSql(interval);
		const result = await sql<{
			currency: string;
			bucket: string;
			revenue: number | string;
			refunded: number | string;
		}>`
			SELECT u.currency AS currency,
			       u.bucket AS bucket,
			       SUM(u.revenue_cents) AS revenue,
			       SUM(u.refunded_cents) AS refunded
			FROM (
				SELECT ot.currency AS currency,
				       ${bucket} AS bucket,
				       ot.total_cents AS revenue_cents,
				       0 AS refunded_cents
				FROM orders o
				JOIN order_totals ot ON ot.order_id = o.id
				WHERE o.created_at BETWEEN ${range.from} AND ${range.to}
				  AND o.state IN ${REVENUE_STATES_IN}
				UNION ALL
				SELECT r.currency AS currency,
				       ${bucket} AS bucket,
				       0 AS revenue_cents,
				       r.amount_cents AS refunded_cents
				FROM refunds r
				JOIN orders o ON o.id = r.order_id
				WHERE o.created_at BETWEEN ${range.from} AND ${range.to}
				  AND r.status = ${FINALIZED_REFUND_STATUS}
			) AS u
			GROUP BY u.currency, u.bucket
			ORDER BY bucket ASC, currency ASC
		`.execute(this.#db);
		return result.rows.map((r) => ({
			bucketStart: r.bucket,
			currency: toCurrency(r.currency),
			revenueCents: cents(parseAggregate(r.revenue)),
			refundedCents: cents(parseAggregate(r.refunded)),
		}));
	}

	async ordersByStatus(range: DateRange): Promise<StatusCount[]> {
		const result = await sql<{ status: string; order_count: number | string }>`
			SELECT state AS status, COUNT(*) AS order_count
			FROM orders
			WHERE created_at BETWEEN ${range.from} AND ${range.to}
			GROUP BY state
			ORDER BY state ASC
		`.execute(this.#db);
		return result.rows.map((r) => ({
			status: r.status,
			orderCount: parseAggregate(r.order_count),
		}));
	}

	async topProducts(
		range: DateRange,
		metric: TopProductsMetric,
		limit: number,
	): Promise<TopProduct[]> {
		const orderMetric = metric === "quantity" ? sql`qty_sold` : sql`revenue`;
		const result = await sql<{
			product_id: string;
			title: string;
			qty_sold: number | string;
			revenue: number | string;
		}>`
			SELECT oi.product_id AS product_id,
			       oi.title AS title,
			       SUM(oi.quantity) AS qty_sold,
			       -- CAST one factor to bigint so the per-line product is computed in
			       -- 64 bits: on pg both columns are int4 and the qty*price product would
			       -- raise "integer out of range" BEFORE SUM widens (sqlite is 64-bit
			       -- natively). CAST(... AS bigint) is portable across both dialects.
			       SUM(CAST(oi.quantity AS bigint) * oi.unit_price_cents) AS revenue
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			WHERE o.created_at BETWEEN ${range.from} AND ${range.to}
			  AND o.state IN ${REVENUE_STATES_IN}
			GROUP BY oi.product_id, oi.title
			ORDER BY ${orderMetric} DESC, oi.product_id ASC
			LIMIT ${limit}
		`.execute(this.#db);
		return result.rows.map((r) => ({
			productId: r.product_id,
			titleSnapshot: r.title,
			qtySold: parseAggregate(r.qty_sold),
			revenueCents: cents(parseAggregate(r.revenue)),
		}));
	}

	/**
	 * Low stock (port doc), with the LIVE product's title joined on.
	 *
	 * The `deleted_at IS NULL` half of the ON clause is LOAD-BEARING, not
	 * defensive noise: `product_commerce` enforces sku uniqueness with a
	 * PARTIAL unique index over live rows only (migration 0002), precisely so a
	 * soft-deleted product releases its sku for reuse. Join on sku alone and a
	 * tombstone sharing a live sku duplicates the low-stock row and can win the
	 * title; with the predicate the join is at most 1:1 and only a live product
	 * titles a row. A sku with no live product yields `title: null` — the sku
	 * is NEVER substituted (port doc). Identical DDL-free SQL on both dialects.
	 */
	async lowStock(threshold: number): Promise<LowStockRow[]> {
		const rows = await this.#db
			.selectFrom("inventory")
			.leftJoin("product_commerce", (join) =>
				join
					.onRef("product_commerce.sku", "=", "inventory.sku")
					.on("product_commerce.deleted_at", "is", null),
			)
			.select([
				"inventory.sku as sku",
				"inventory.on_hand as on_hand",
				"product_commerce.title as title",
			])
			.where("inventory.on_hand", "<=", threshold)
			.orderBy("inventory.on_hand", "asc")
			.orderBy("inventory.sku", "asc")
			.execute();
		return rows.map((r) => ({ sku: r.sku, onHand: r.on_hand, title: r.title }));
	}

	/**
	 * The one dialect-branched fragment (§4.2): a canonical UTC bucket-start text
	 * (`YYYY-MM-DDT00:00:00.000Z`), identical across dialects. `week` truncates to
	 * the ISO-8601 Monday on both (pg `date_trunc('week')`; SQLite `weekday 1`).
	 */
	#bucketSql(interval: ReportInterval): RawBuilder<string> {
		if (this.#dialect === "postgres") {
			// Force UTC: cast the ISO-Z text to timestamptz, then re-anchor to UTC wall
			// clock so date_trunc is session-timezone-independent.
			return sql<string>`to_char(date_trunc(${interval}, (o.created_at)::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
		}
		// better-sqlite3: strftime over the ISO text (non-% chars are literal).
		if (interval === "month") {
			return sql<string>`strftime('%Y-%m-01T00:00:00.000Z', o.created_at)`;
		}
		if (interval === "week") {
			return sql<string>`strftime('%Y-%m-%dT00:00:00.000Z', o.created_at, '-6 days', 'weekday 1')`;
		}
		return sql<string>`strftime('%Y-%m-%dT00:00:00.000Z', o.created_at)`;
	}
}
