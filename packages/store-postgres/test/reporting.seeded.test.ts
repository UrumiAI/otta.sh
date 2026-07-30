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
	type ReportingStoreHarness,
} from "@otta-sh/domain/testing";
import { afterEach, describe, expect, test } from "vitest";
import {
	makePgReportingHarness,
	makeSqliteReportingHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

afterEach(teardownDialects);

async function seeded(make: () => Promise<ReportingStoreHarness>): Promise<ReportingStoreHarness> {
	const h = await make();
	for (const o of FIXTURE_ORDERS) await h.seedOrder(o);
	for (const it of FIXTURE_ITEMS) await h.seedOrderItem(it);
	for (const inv of FIXTURE_INVENTORY) await h.seedInventory(inv);
	return h;
}

// Deterministic LCG so the "large randomized cents" property is reproducible.
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1_664_525 + 1_013_904_223) >>> 0;
		return s;
	};
}

// The phase's NAMED headline test, on both dialects.
function suite(make: () => Promise<ReportingStoreHarness>, dialect: string): void {
	describe(`reporting seeded aggregates [${dialect}]`, () => {
		test("reporting queries return correct aggregates over seeded orders", async () => {
			const { store } = await seeded(make);

			// Revenue: exact hand-computed buckets, grouped by currency, day buckets.
			const revenue = await store.revenueByPeriod(REPORTING_WINDOW, "day");
			expect(revenue).toEqual(EXPECTED_REVENUE_BY_DAY);

			// Revenue is the allow-list sum — provably NOT "sum everything" and NOT
			// "sum excluding only cancelled/refunded" (which still counts
			// pending/failed/expired). Revenue reads order_totals.total_cents, never a
			// column on `orders` (it has none).
			const total = revenue.reduce((s, b) => s + b.revenueCents, 0);
			expect(total).toBe(EXPECTED_TOTAL_REVENUE);
			expect(total).not.toBe(EXPECTED_SUM_ALL);
			expect(total).not.toBe(EXPECTED_SUM_EXCLUDING_CANCELLED_REFUNDED);

			// Orders-by-status counts EVERY state, including expired.
			expect(await store.ordersByStatus(REPORTING_WINDOW)).toEqual(EXPECTED_ORDERS_BY_STATUS);
			expect(
				(await store.ordersByStatus(REPORTING_WINDOW)).find((s) => s.status === "expired"),
			).toEqual({ status: "expired", orderCount: 1 });

			// Top-products uses the order_items snapshot (no product_commerce rows were
			// ever seeded), same allow-list — excluded orders' items never count.
			expect(await store.topProducts(REPORTING_WINDOW, "revenue", 10)).toEqual(
				EXPECTED_TOP_BY_REVENUE,
			);
			expect(await store.topProducts(REPORTING_WINDOW, "quantity", 10)).toEqual(
				EXPECTED_TOP_BY_QUANTITY,
			);
			expect(await store.topProducts(REPORTING_WINDOW, "revenue", 2)).toEqual(
				EXPECTED_TOP_BY_REVENUE.slice(0, 2),
			);

			// Low-stock straddles the threshold.
			expect(await store.lowStock(5)).toEqual([
				{ sku: "SKU-A", onHand: 0 },
				{ sku: "SKU-B", onHand: 3 },
				{ sku: "SKU-C", onHand: 5 },
				{ sku: "SKU-E", onHand: 5 },
			]);
		});

		test("revenue SUM stays an exact integer under a large randomized set of cents (no float drift)", async () => {
			const h = await make();
			const rng = makeRng(0xc0ffee);
			const N = 250;
			// Each amount < 2.1e9 to fit the `integer` (int4) total_cents column;
			// Σ over 250 orders < 5e11, safely within Number.MAX_SAFE_INTEGER, so the
			// exact integer sum is representable (pg SUM(int4) widens to int8/bigint).
			let expected = 0;
			for (let i = 0; i < N; i++) {
				const amount = 1 + (rng() % 2_000_000_000);
				expected += amount;
				await h.seedOrder({
					id: `r${i}`,
					state: "paid",
					currency: "USD",
					createdAt: "2026-07-10T12:00:00.000Z",
					totalCents: amount,
				});
			}
			const buckets = await h.store.revenueByPeriod(REPORTING_WINDOW, "day");
			expect(buckets).toHaveLength(1);
			expect(buckets[0]?.revenueCents).toBe(expected);
			expect(Number.isSafeInteger(buckets[0]?.revenueCents ?? NaN)).toBe(true);
		});
	});
}

suite(makeSqliteReportingHarness, "sqlite");
if (PG_ENABLED) suite(makePgReportingHarness, "postgres");
