import { cents, currency as toCurrency } from "../money/cents.js";
import {
	type DateRange,
	type LowStockRow,
	type PeriodBucket,
	type ReportInterval,
	type ReportingStore,
	REVENUE_COUNTING_STATES,
	type StatusCount,
	type TopProduct,
	type TopProductsMetric,
} from "../ports/reporting-store.js";

/** Seed shapes mirroring the real `orders` / `order_totals` / `order_items` /
 *  `inventory` rows the adapter reads — the fake is seeded with the same fixture
 *  the dialect contract seeds into SQL, so both assert identical numbers. */
export interface SeedOrderRow {
	id: string;
	state: string;
	currency: string;
	createdAt: string;
	/** The Phase-6-authoritative `order_totals.total_cents`. */
	totalCents: number;
}
export interface SeedOrderItemRow {
	orderId: string;
	productId: string;
	title: string;
	unitPriceCents: number;
	quantity: number;
}
export interface SeedInventoryRow {
	sku: string;
	onHand: number;
}
/** A `product_commerce` row, only as much of it as `lowStock`'s title join
 *  reads: the sku it claims, its title, and whether it is a tombstone. */
export interface SeedProductTitleRow {
	sku: string;
	title: string | null;
	/** Soft-delete tombstone. A tombstoned row must NEVER title a low-stock row
	 *  nor duplicate it — the adapters' ON clause carries `deleted_at IS NULL`
	 *  because live-sku uniqueness is only a PARTIAL index (migration 0002), so
	 *  a live row and any number of tombstones can share one sku. */
	deletedAt?: string | null;
}

const REVENUE_STATES: ReadonlySet<string> = new Set(REVENUE_COUNTING_STATES);

/**
 * IO-free `ReportingStore` fake (first adapter to pass `reportingStoreContract`).
 * Computes the four aggregates in plain JS over seeded rows, applying the exact
 * same revenue-counting allow-list, snapshot rule, and period-bucket boundaries
 * as the SQL adapter — proving the report SHAPE before any DB.
 */
export class InMemoryReportingStore implements ReportingStore {
	#orders: SeedOrderRow[] = [];
	#items: SeedOrderItemRow[] = [];
	#inventory: SeedInventoryRow[] = [];
	#products: SeedProductTitleRow[] = [];

	seedOrder(row: SeedOrderRow): void {
		this.#orders.push(row);
	}
	seedOrderItem(row: SeedOrderItemRow): void {
		this.#items.push(row);
	}
	seedInventory(row: SeedInventoryRow): void {
		this.#inventory.push(row);
	}
	seedProduct(row: SeedProductTitleRow): void {
		this.#products.push(row);
	}

	async revenueByPeriod(range: DateRange, interval: ReportInterval): Promise<PeriodBucket[]> {
		const groups = new Map<
			string,
			{ bucketStart: string; currency: string; revenueCents: number }
		>();
		for (const o of this.#orders) {
			if (!inWindow(o.createdAt, range) || !REVENUE_STATES.has(o.state)) continue;
			const bucketStart = truncateToBucket(o.createdAt, interval);
			const key = JSON.stringify([bucketStart, o.currency]);
			const g = groups.get(key) ?? { bucketStart, currency: o.currency, revenueCents: 0 };
			g.revenueCents += o.totalCents;
			groups.set(key, g);
		}
		return [...groups.values()]
			.toSorted((a, b) =>
				a.bucketStart === b.bucketStart
					? a.currency.localeCompare(b.currency)
					: a.bucketStart.localeCompare(b.bucketStart),
			)
			.map((g) => ({
				bucketStart: g.bucketStart,
				currency: toCurrency(g.currency),
				revenueCents: cents(g.revenueCents),
			}));
	}

	async ordersByStatus(range: DateRange): Promise<StatusCount[]> {
		const counts = new Map<string, number>();
		for (const o of this.#orders) {
			if (!inWindow(o.createdAt, range)) continue;
			counts.set(o.state, (counts.get(o.state) ?? 0) + 1);
		}
		return [...counts.entries()]
			.toSorted((a, b) => a[0].localeCompare(b[0]))
			.map(([status, orderCount]) => ({ status, orderCount }));
	}

	async topProducts(
		range: DateRange,
		metric: TopProductsMetric,
		limit: number,
	): Promise<TopProduct[]> {
		const revenueOrders = new Set(
			this.#orders
				.filter((o) => inWindow(o.createdAt, range) && REVENUE_STATES.has(o.state))
				.map((o) => o.id),
		);
		const groups = new Map<
			string,
			{ productId: string; title: string; qtySold: number; revenueCents: number }
		>();
		for (const it of this.#items) {
			if (!revenueOrders.has(it.orderId)) continue;
			const key = JSON.stringify([it.productId, it.title]);
			const g = groups.get(key) ?? {
				productId: it.productId,
				title: it.title,
				qtySold: 0,
				revenueCents: 0,
			};
			g.qtySold += it.quantity;
			g.revenueCents += it.quantity * it.unitPriceCents;
			groups.set(key, g);
		}
		return [...groups.values()]
			.toSorted((a, b) => {
				const av = metric === "quantity" ? a.qtySold : a.revenueCents;
				const bv = metric === "quantity" ? b.qtySold : b.revenueCents;
				return bv === av ? a.productId.localeCompare(b.productId) : bv - av;
			})
			.slice(0, limit)
			.map((g) => ({
				productId: g.productId,
				titleSnapshot: g.title,
				qtySold: g.qtySold,
				revenueCents: cents(g.revenueCents),
			}));
	}

	/** EXACT parity with `KyselyReportingStore.lowStock`, including the title
	 *  join's tombstone predicate: only a LIVE product row can title a sku, so a
	 *  soft-deleted row sharing the sku neither duplicates the row nor supplies
	 *  its title. No live match ⇒ `title: null`, never the sku (port doc). */
	async lowStock(threshold: number): Promise<LowStockRow[]> {
		const liveTitle = (sku: string): string | null =>
			this.#products.find((p) => p.sku === sku && (p.deletedAt ?? null) === null)?.title ?? null;
		return this.#inventory
			.filter((r) => r.onHand <= threshold)
			.toSorted((a, b) =>
				a.onHand === b.onHand ? a.sku.localeCompare(b.sku) : a.onHand - b.onHand,
			)
			.map((r) => ({ sku: r.sku, onHand: r.onHand, title: liveTitle(r.sku) }));
	}
}

function inWindow(createdAt: string, range: DateRange): boolean {
	return createdAt >= range.from && createdAt <= range.to;
}

/**
 * Canonical UTC bucket start for `createdAt`, matching the SQL adapter's
 * `truncateToInterval` byte-for-byte. `week` truncates to the ISO-8601 Monday
 * (parity with Postgres `date_trunc('week')` and the SQLite `weekday 1` modifier).
 */
export function truncateToBucket(createdAt: string, interval: ReportInterval): string {
	const d = new Date(createdAt);
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	const day = d.getUTCDate();
	if (interval === "month") {
		return isoDay(y, m, 1);
	}
	if (interval === "week") {
		// Monday-based: shift back (weekday + 6) % 7 days (Sun=0 → 6 back).
		const dow = d.getUTCDay();
		const back = (dow + 6) % 7;
		const monday = new Date(Date.UTC(y, m, day - back));
		return isoDay(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
	}
	return isoDay(y, m, day);
}

function isoDay(year: number, monthIndex: number, day: number): string {
	const yy = String(year).padStart(4, "0");
	const mm = String(monthIndex + 1).padStart(2, "0");
	const dd = String(day).padStart(2, "0");
	return `${yy}-${mm}-${dd}T00:00:00.000Z`;
}
