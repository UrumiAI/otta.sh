import type {
	DateRange,
	LowStockRow,
	PeriodBucket,
	ReportInterval,
	ReportingStore,
	StatusCount,
	TopProduct,
	TopProductsMetric,
} from "../ports/reporting-store.js";
import type { SettingsStore } from "../ports/settings-store.js";

/**
 * Thin IO-free orchestration over `ReportingStore` (Phase 7 §6). These use-cases
 * do nothing but validate intent and shape the result — reporting needs no
 * business-rule orchestration; the port exists for dialect-parity testing and
 * the future in-process store swap (§4.1).
 */

/** The public-surface guard: an unbounded `from`/`to` range is an unbounded scan
 *  (§4.2). Both the domain use-cases and the service edge enforce it. */
export const MAX_REPORT_RANGE_DAYS = 400;
const MAX_REPORT_RANGE_MS = MAX_REPORT_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** Thrown when a report `from`/`to` window exceeds `MAX_REPORT_RANGE_DAYS`. The
 *  service maps this to a `400` + structured error, never a silent clamp. */
export class ReportRangeTooWideError extends Error {
	constructor(days: number) {
		super(`report range of ${days} days exceeds the ${MAX_REPORT_RANGE_DAYS}-day maximum`);
		this.name = "ReportRangeTooWideError";
	}
}

function assertRange(range: DateRange): void {
	const from = Date.parse(range.from);
	const to = Date.parse(range.to);
	if (Number.isNaN(from) || Number.isNaN(to)) {
		throw new RangeError(`report range requires ISO-8601 from/to, got ${range.from}..${range.to}`);
	}
	const widthMs = to - from;
	if (widthMs > MAX_REPORT_RANGE_MS) {
		throw new ReportRangeTooWideError(Math.ceil(widthMs / (24 * 60 * 60 * 1000)));
	}
}

export async function getRevenueReport(
	store: ReportingStore,
	range: DateRange,
	interval: ReportInterval,
): Promise<PeriodBucket[]> {
	assertRange(range);
	return store.revenueByPeriod(range, interval);
}

export async function getOrdersByStatusReport(
	store: ReportingStore,
	range: DateRange,
): Promise<StatusCount[]> {
	assertRange(range);
	return store.ordersByStatus(range);
}

export async function getTopProductsReport(
	store: ReportingStore,
	range: DateRange,
	metric: TopProductsMetric,
	limit: number,
): Promise<TopProduct[]> {
	assertRange(range);
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RangeError(`top-products limit must be a positive integer, got ${String(limit)}`);
	}
	return store.topProducts(range, metric, limit);
}

export interface LowStockReportDeps {
	reportingStore: ReportingStore;
	settingsStore: SettingsStore;
}

/**
 * Low-stock report. When the caller omits `threshold`, it defaults from the
 * operational `SettingsStore.lowStockThreshold` (§4.2) — this is the sole
 * orchestration in the report set.
 */
export async function getLowStockReport(
	deps: LowStockReportDeps,
	threshold?: number,
): Promise<LowStockRow[]> {
	const effective = threshold ?? (await deps.settingsStore.get()).lowStockThreshold;
	if (!Number.isSafeInteger(effective) || effective < 0) {
		throw new RangeError(
			`low-stock threshold must be a non-negative integer, got ${String(effective)}`,
		);
	}
	return deps.reportingStore.lowStock(effective);
}
