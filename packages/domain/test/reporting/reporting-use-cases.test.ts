import {
	getLowStockReport,
	getOrdersByStatusReport,
	getRevenueReport,
	getTopProductsReport,
	ReportRangeTooWideError,
} from "@otta-sh/domain";
import {
	EXPECTED_ORDERS_BY_STATUS,
	EXPECTED_REVENUE_BY_DAY,
	EXPECTED_TOP_BY_QUANTITY,
	EXPECTED_TOP_BY_REVENUE,
	FIXTURE_INVENTORY,
	FIXTURE_ITEMS,
	FIXTURE_ORDERS,
	InMemoryReportingStore,
	InMemorySettingsStore,
	REPORTING_WINDOW,
} from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";

function seededStore(): InMemoryReportingStore {
	const store = new InMemoryReportingStore();
	for (const o of FIXTURE_ORDERS) store.seedOrder(o);
	for (const it of FIXTURE_ITEMS) store.seedOrderItem(it);
	for (const inv of FIXTURE_INVENTORY) store.seedInventory(inv);
	return store;
}

describe("reporting use-cases (over the in-memory fake)", () => {
	let store: InMemoryReportingStore;
	beforeEach(() => {
		store = seededStore();
	});

	test("getRevenueReport sums order_totals.total_cents in Cents per period bucket, grouped by currency", async () => {
		expect(await getRevenueReport(store, REPORTING_WINDOW, "day")).toEqual(EXPECTED_REVENUE_BY_DAY);
	});

	test("getRevenueReport counts only paid/processing/shipped/delivered/completed orders", async () => {
		const buckets = await getRevenueReport(store, REPORTING_WINDOW, "day");
		const total = buckets.reduce((s, b) => s + b.revenueCents, 0);
		expect(total).toBe(20_500);
	});

	test("getRevenueReport excludes pending, failed, expired, cancelled, and refunded orders", async () => {
		const buckets = await getRevenueReport(store, REPORTING_WINDOW, "day");
		const total = buckets.reduce((s, b) => s + b.revenueCents, 0);
		// Sum-of-everything (59385) and exclude-only-cancelled/refunded (44942) are both wrong.
		expect(total).not.toBe(59_385);
		expect(total).not.toBe(44_942);
	});

	test("getOrdersByStatusReport counts orders per state for the period, including expired", async () => {
		expect(await getOrdersByStatusReport(store, REPORTING_WINDOW)).toEqual(
			EXPECTED_ORDERS_BY_STATUS,
		);
	});

	test("getTopProductsReport ranks products by revenue, limited to N, using the order_items title/unit_price_cents/quantity snapshot", async () => {
		expect(await getTopProductsReport(store, REPORTING_WINDOW, "revenue", 2)).toEqual(
			EXPECTED_TOP_BY_REVENUE.slice(0, 2),
		);
	});

	test("getTopProductsReport ranks by quantity when metric=quantity", async () => {
		expect(await getTopProductsReport(store, REPORTING_WINDOW, "quantity", 10)).toEqual(
			EXPECTED_TOP_BY_QUANTITY,
		);
	});

	test("getTopProductsReport applies the same revenue-counting state allow-list as getRevenueReport", async () => {
		const top = await getTopProductsReport(store, REPORTING_WINDOW, "quantity", 10);
		expect(top.find((t) => t.productId === "p1")?.qtySold).toBe(7); // excludes o8's ×50
		expect(top.find((t) => t.productId === "p4")?.qtySold).toBe(2); // excludes o3's ×10
	});

	test("getTopProductsReport rejects a non-positive limit", async () => {
		await expect(getTopProductsReport(store, REPORTING_WINDOW, "revenue", 0)).rejects.toThrow(
			RangeError,
		);
	});

	test("getLowStockReport returns SKUs at or below threshold, ascending by on_hand", async () => {
		const settings = new InMemorySettingsStore();
		const rows = await getLowStockReport({ reportingStore: store, settingsStore: settings }, 3);
		expect(rows).toEqual([
			{ sku: "SKU-A", onHand: 0 },
			{ sku: "SKU-B", onHand: 3 },
		]);
	});

	test("getLowStockReport defaults the threshold from SettingsStore.lowStockThreshold when omitted", async () => {
		const settings = new InMemorySettingsStore();
		await settings.update(
			{ lowStockThreshold: 0 },
			(await import("@otta-sh/domain")).idempotencyKey("k-thr"),
		);
		const rows = await getLowStockReport({ reportingStore: store, settingsStore: settings });
		// threshold defaults to 0 → only SKU-A(0).
		expect(rows).toEqual([{ sku: "SKU-A", onHand: 0 }]);
	});

	test("getRevenueReport/getOrdersByStatusReport/getTopProductsReport reject a from/to range wider than 400 days", async () => {
		const wide = { from: "2024-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" }; // ~730 days
		await expect(getRevenueReport(store, wide, "day")).rejects.toThrow(ReportRangeTooWideError);
		await expect(getOrdersByStatusReport(store, wide)).rejects.toThrow(ReportRangeTooWideError);
		await expect(getTopProductsReport(store, wide, "revenue", 5)).rejects.toThrow(
			ReportRangeTooWideError,
		);
	});
});
