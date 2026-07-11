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
} from "@urumi/domain";
import { type Kysely, type RawBuilder, sql } from "kysely";
import type { Database } from "./schema.js";

export type ReportingDialect = "sqlite" | "postgres";

export interface KyselyReportingStoreOptions {
	db: Kysely<Database>;
	/** The single piece of dialect knowledge this phase needs — the period-bucket
	 *  expression branches on it (§4.2); everything else is portable SQL. */
	dialect: ReportingDialect;
}

/** The revenue-counting state allow-list as a parameterized SQL `IN (…)` list —
 *  built ONCE from the domain constant so both revenue and top-products share it
 *  (never reimplemented, never drifts). */
const REVENUE_STATES_IN: RawBuilder<unknown> = sql`(${sql.join(
	REVENUE_COUNTING_STATES.map((s) => sql.val(s)),
)})`;

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

	async revenueByPeriod(range: DateRange, interval: ReportInterval): Promise<PeriodBucket[]> {
		const bucket = this.#bucketSql(interval);
		const result = await sql<{ currency: string; bucket: string; revenue: number | string }>`
			SELECT ot.currency AS currency,
			       ${bucket} AS bucket,
			       SUM(ot.total_cents) AS revenue
			FROM orders o
			JOIN order_totals ot ON ot.order_id = o.id
			WHERE o.created_at BETWEEN ${range.from} AND ${range.to}
			  AND o.state IN ${REVENUE_STATES_IN}
			GROUP BY 1, 2
			ORDER BY bucket ASC, currency ASC
		`.execute(this.#db);
		return result.rows.map((r) => ({
			bucketStart: r.bucket,
			currency: toCurrency(r.currency),
			revenueCents: cents(Number(r.revenue)),
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
		return result.rows.map((r) => ({ status: r.status, orderCount: Number(r.order_count) }));
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
			       SUM(oi.quantity * oi.unit_price_cents) AS revenue
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
			qtySold: Number(r.qty_sold),
			revenueCents: cents(Number(r.revenue)),
		}));
	}

	async lowStock(threshold: number): Promise<LowStockRow[]> {
		const rows = await this.#db
			.selectFrom("inventory")
			.select(["sku", "on_hand"])
			.where("on_hand", "<=", threshold)
			.orderBy("on_hand", "asc")
			.orderBy("sku", "asc")
			.execute();
		return rows.map((r) => ({ sku: r.sku, onHand: r.on_hand }));
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
