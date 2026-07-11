import { describe, expect, test } from "vitest";
import type { ReportingStore } from "../ports/reporting-store.js";
import {
	EXPECTED_ORDERS_BY_STATUS,
	EXPECTED_REVENUE_BY_DAY,
	EXPECTED_SUM_ALL,
	EXPECTED_SUM_EXCLUDING_CANCELLED_REFUNDED,
	EXPECTED_TOP_BY_QUANTITY,
	EXPECTED_TOP_BY_REVENUE,
	EXPECTED_TOTAL_REVENUE,
	FIXTURE_INVENTORY,
	FIXTURE_ITEMS,
	FIXTURE_ORDERS,
	REPORTING_WINDOW,
} from "./reporting-fixture.js";

/** The adapter-agnostic seed surface every `ReportingStore` contract runs behind
 *  (the fake pushes to memory; the Kysely harness inserts real rows). */
export interface ReportingStoreHarness {
	store: ReportingStore;
	seedOrder(row: {
		id: string;
		state: string;
		currency: string;
		createdAt: string;
		totalCents: number;
	}): Promise<void>;
	seedOrderItem(row: {
		orderId: string;
		productId: string;
		title: string;
		unitPriceCents: number;
		quantity: number;
	}): Promise<void>;
	seedInventory(row: { sku: string; onHand: number }): Promise<void>;
}

export interface ReportingStoreContractOptions {
	dialect: string;
}

/** Behavioral spec for every `ReportingStore` adapter (Phase 7 §4/§6). */
export function reportingStoreContract(
	makeStore: () => Promise<ReportingStoreHarness>,
	opts: ReportingStoreContractOptions,
): void {
	describe(`reportingStoreContract [${opts.dialect}]`, () => {
		async function seeded(): Promise<ReportingStoreHarness> {
			const h = await makeStore();
			for (const o of FIXTURE_ORDERS) await h.seedOrder(o);
			for (const it of FIXTURE_ITEMS) await h.seedOrderItem(it);
			for (const inv of FIXTURE_INVENTORY) await h.seedInventory(inv);
			return h;
		}

		test("revenueByPeriod sums order_totals.total_cents in Cents per day bucket, grouped by currency", async () => {
			const { store } = await seeded();
			const buckets = await store.revenueByPeriod(REPORTING_WINDOW, "day");
			expect(buckets).toEqual(EXPECTED_REVENUE_BY_DAY);
		});

		test("revenueByPeriod counts only paid/processing/shipped/delivered/completed — an allow-list, not exclude-cancelled/refunded", async () => {
			const { store } = await seeded();
			const buckets = await store.revenueByPeriod(REPORTING_WINDOW, "day");
			const total = buckets.reduce((s, b) => s + b.revenueCents, 0);
			expect(total).toBe(EXPECTED_TOTAL_REVENUE);
			// The fixture makes the allow-list sum differ from both wrong logics.
			expect(total).not.toBe(EXPECTED_SUM_ALL);
			expect(total).not.toBe(EXPECTED_SUM_EXCLUDING_CANCELLED_REFUNDED);
		});

		test("revenueByPeriod buckets by month", async () => {
			const { store } = await seeded();
			const buckets = await store.revenueByPeriod(REPORTING_WINDOW, "month");
			// All three fixture days fall in 2026-07 → one bucket per currency.
			expect(buckets).toEqual([
				{ bucketStart: "2026-07-01T00:00:00.000Z", currency: "EUR", revenueCents: 9000 },
				{ bucketStart: "2026-07-01T00:00:00.000Z", currency: "USD", revenueCents: 11_500 },
			]);
		});

		test("revenueByPeriod buckets by week, truncating to the ISO Monday and SPLITTING across a Sunday→Monday boundary", async () => {
			// A fresh, controlled set straddling the Sun 2026-07-12 → Mon 2026-07-13
			// boundary. Week-of-Mon-Jul-6 (Jul 6–12) vs week-of-Mon-Jul-13 (Jul 13–19).
			// All three impls (pg date_trunc('week'), sqlite '-6 days'+'weekday 1', the
			// fake's (dow+6)%7) must agree on the same ISO-Monday bucket starts.
			const h = await makeStore();
			await h.seedOrder({
				id: "w-sun",
				state: "paid",
				currency: "USD",
				createdAt: "2026-07-12T23:00:00.000Z", // Sunday → week of Mon Jul 6
				totalCents: 1000,
			});
			await h.seedOrder({
				id: "w-mon",
				state: "paid",
				currency: "USD",
				createdAt: "2026-07-13T01:00:00.000Z", // Monday → week of Mon Jul 13
				totalCents: 2000,
			});
			await h.seedOrder({
				id: "w-wed",
				state: "shipped",
				currency: "USD",
				createdAt: "2026-07-15T12:00:00.000Z", // same week as w-mon → aggregates
				totalCents: 500,
			});
			const weeks = await h.store.revenueByPeriod(
				{ from: "2026-07-01T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z" },
				"week",
			);
			expect(weeks).toEqual([
				{ bucketStart: "2026-07-06T00:00:00.000Z", currency: "USD", revenueCents: 1000 },
				{ bucketStart: "2026-07-13T00:00:00.000Z", currency: "USD", revenueCents: 2500 },
			]);
		});

		test("ordersByStatus counts orders per state for the window, including expired", async () => {
			const { store } = await seeded();
			expect(await store.ordersByStatus(REPORTING_WINDOW)).toEqual(EXPECTED_ORDERS_BY_STATUS);
		});

		test("topProducts ranks by revenue using the order_items title/unit_price_cents/quantity snapshot", async () => {
			const { store } = await seeded();
			expect(await store.topProducts(REPORTING_WINDOW, "revenue", 10)).toEqual(
				EXPECTED_TOP_BY_REVENUE,
			);
		});

		test("topProducts ranks by quantity when metric=quantity", async () => {
			const { store } = await seeded();
			expect(await store.topProducts(REPORTING_WINDOW, "quantity", 10)).toEqual(
				EXPECTED_TOP_BY_QUANTITY,
			);
		});

		test("topProducts respects the limit", async () => {
			const { store } = await seeded();
			expect(await store.topProducts(REPORTING_WINDOW, "revenue", 2)).toEqual(
				EXPECTED_TOP_BY_REVENUE.slice(0, 2),
			);
		});

		test("topProducts applies the same revenue-counting allow-list (excluded orders' items never count)", async () => {
			const { store } = await seeded();
			const top = await store.topProducts(REPORTING_WINDOW, "quantity", 10);
			// o3 (pending, p4 ×10) and o8 (cancelled, p1 ×50) must NOT inflate any row.
			const p1 = top.find((t) => t.productId === "p1");
			const p4 = top.find((t) => t.productId === "p4");
			expect(p1?.qtySold).toBe(7); // not 57
			expect(p4?.qtySold).toBe(2); // not 12
		});

		test("topProducts revenue does not overflow when a single line's quantity × unit_price exceeds a 32-bit int", async () => {
			// On pg both columns are int4; `quantity * unit_price_cents` is evaluated
			// as integer and would raise "integer out of range" BEFORE SUM widens to
			// bigint. SQLite (64-bit) would not — a real dialect divergence on money.
			// 40000 × 60000 = 2.4e9 > 2^31 (2,147,483,647), still a safe JS integer.
			const h = await makeStore();
			await h.seedOrder({
				id: "big",
				state: "paid",
				currency: "USD",
				createdAt: "2026-07-11T00:00:00.000Z",
				totalCents: 1,
			});
			await h.seedOrderItem({
				orderId: "big",
				productId: "pbig",
				title: "Bulk",
				unitPriceCents: 60_000,
				quantity: 40_000,
			});
			const top = await h.store.topProducts(REPORTING_WINDOW, "revenue", 10);
			expect(top).toEqual([
				{ productId: "pbig", titleSnapshot: "Bulk", qtySold: 40_000, revenueCents: 2_400_000_000 },
			]);
		});

		test("lowStock returns SKUs at or below threshold, ascending by on_hand", async () => {
			const { store } = await seeded();
			expect(await store.lowStock(5)).toEqual([
				{ sku: "SKU-A", onHand: 0 },
				{ sku: "SKU-B", onHand: 3 },
				{ sku: "SKU-C", onHand: 5 },
				{ sku: "SKU-E", onHand: 5 },
			]);
			expect(await store.lowStock(3)).toEqual([
				{ sku: "SKU-A", onHand: 0 },
				{ sku: "SKU-B", onHand: 3 },
			]);
			expect(await store.lowStock(0)).toEqual([{ sku: "SKU-A", onHand: 0 }]);
		});

		test("revenueByPeriod on an empty window returns no buckets", async () => {
			const { store } = await seeded();
			const empty = await store.revenueByPeriod(
				{ from: "2020-01-01T00:00:00.000Z", to: "2020-12-31T00:00:00.000Z" },
				"day",
			);
			expect(empty).toEqual([]);
		});
	});
}
