import { describe, expect, test } from "vitest";
import type { ReportingStore } from "../ports/reporting-store.js";
import {
	EXPECTED_ACTIVE_REFUND_SUM,
	EXPECTED_ORDERS_BY_STATUS,
	EXPECTED_REFUNDS_UNDER_REVENUE_ALLOW_LIST,
	EXPECTED_REVENUE_BY_DAY,
	EXPECTED_SUM_ALL,
	EXPECTED_SUM_EXCLUDING_CANCELLED_REFUNDED,
	EXPECTED_TOP_BY_QUANTITY,
	EXPECTED_TOP_BY_REVENUE,
	EXPECTED_TOTAL_REFUNDED,
	EXPECTED_TOTAL_REVENUE,
	FIXTURE_INVENTORY,
	FIXTURE_ITEMS,
	FIXTURE_ORDERS,
	FIXTURE_PRODUCT_TITLES,
	FIXTURE_REFUNDS,
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
	/** Seed a `refunds` ledger row for `revenueByPeriod`'s refunded half. `status`
	 *  defaults to `'recorded'` (the column default) — only that state is money
	 *  that came back. The row needs no timestamp of its own: the bucket comes
	 *  from the ORDER's `created_at`. */
	seedRefund(row: {
		orderId: string;
		amountCents: number;
		currency: string;
		status?: string;
	}): Promise<void>;
	/** Seed a `product_commerce` row behind a sku, for `lowStock`'s title join.
	 *  Several rows MAY share one sku as long as at most one is live — that is
	 *  exactly what the partial unique index permits, and the case the join's
	 *  `deleted_at IS NULL` predicate exists to survive. */
	seedProduct(row: { sku: string; title: string | null; deletedAt?: string | null }): Promise<void>;
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
			for (const p of FIXTURE_PRODUCT_TITLES) await h.seedProduct(p);
			for (const r of FIXTURE_REFUNDS) await h.seedRefund(r);
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
				{
					bucketStart: "2026-07-01T00:00:00.000Z",
					currency: "EUR",
					revenueCents: 9000,
					refundedCents: 300,
				},
				{
					bucketStart: "2026-07-01T00:00:00.000Z",
					currency: "USD",
					revenueCents: 11_500,
					refundedCents: 6916,
				},
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
				{
					bucketStart: "2026-07-06T00:00:00.000Z",
					currency: "USD",
					revenueCents: 1000,
					refundedCents: 0,
				},
				{
					bucketStart: "2026-07-13T00:00:00.000Z",
					currency: "USD",
					revenueCents: 2500,
					refundedCents: 0,
				},
			]);
		});

		// -- refundedCents (INC-23: the revenue wire stops omitting refunds) -------

		test("revenueByPeriod carries refundedCents per bucket, aggregating a partial and several refunds on one order — without netting revenue down", async () => {
			const { store } = await seeded();
			const buckets = await store.revenueByPeriod(REPORTING_WINDOW, "day");
			const at = (day: string, currency: string) =>
				buckets.find((b) => b.bucketStart === day && b.currency === currency);
			// o1's 250 came back out of a 1000 order that is still `paid`: the day's
			// revenue is untouched and the refund is stated beside it.
			expect(at("2026-07-10T00:00:00.000Z", "USD")).toEqual({
				bucketStart: "2026-07-10T00:00:00.000Z",
				currency: "USD",
				revenueCents: 3000,
				refundedCents: 250,
			});
			// o4's two rows aggregate (100 + 200), rather than the last one winning.
			expect(at("2026-07-10T00:00:00.000Z", "EUR")?.refundedCents).toBe(300);
		});

		test("refundedCents counts FINALIZED rows only — a reserved/unverified/voided row is not money that came back", async () => {
			const { store } = await seeded();
			const buckets = await store.revenueByPeriod(REPORTING_WINDOW, "day");
			const total = buckets.reduce((s, b) => s + b.refundedCents, 0);
			expect(total).toBe(EXPECTED_TOTAL_REFUNDED);
			// The ceiling's ACTIVE sum (everything but `voided`) is a DIFFERENT number
			// and reusing it here would report in-flight attempts as refunds.
			expect(total).not.toBe(EXPECTED_ACTIVE_REFUND_SUM);
			// 07-11 carries three non-finalized rows between its two currencies and
			// must still read zero in both.
			for (const currency of ["EUR", "USD"]) {
				expect(
					buckets.find(
						(b) => b.bucketStart === "2026-07-11T00:00:00.000Z" && b.currency === currency,
					)?.refundedCents,
				).toBe(0);
			}
		});

		test("refundedCents does NOT apply the revenue allow-list: a fully refunded order's money is still reported", async () => {
			const { store } = await seeded();
			const buckets = await store.revenueByPeriod(REPORTING_WINDOW, "day");
			const total = buckets.reduce((s, b) => s + b.refundedCents, 0);
			// o10 is `refunded` — excluded from revenue by the allow-list. Filtering
			// refunds through the same list would drop exactly the refund that
			// matters most, leaving the money reportable nowhere.
			expect(total).not.toBe(EXPECTED_REFUNDS_UNDER_REVENUE_ALLOW_LIST);
			expect(
				buckets.find((b) => b.bucketStart === "2026-07-12T00:00:00.000Z" && b.currency === "USD")
					?.refundedCents,
			).toBe(6666);
		});

		test("a period whose ONLY activity was a refund is a bucket at revenueCents 0, never a missing bucket", async () => {
			const h = await makeStore();
			await h.seedOrder({
				id: "r-only",
				state: "refunded",
				currency: "USD",
				createdAt: "2026-07-11T09:00:00.000Z",
				totalCents: 4200,
			});
			await h.seedRefund({ orderId: "r-only", amountCents: 4200, currency: "USD" });
			// Nothing here is in the revenue allow-list, so a revenue-only query
			// returns NOTHING for this window — which is precisely how the money used
			// to disappear from the report.
			expect(await h.store.revenueByPeriod(REPORTING_WINDOW, "day")).toEqual([
				{
					bucketStart: "2026-07-11T00:00:00.000Z",
					currency: "USD",
					revenueCents: 0,
					refundedCents: 4200,
				},
			]);
		});

		test("a refund on an order OUTSIDE the window is not reported inside it (the bucket is the ORDER's, not the refund's)", async () => {
			const h = await makeStore();
			await h.seedOrder({
				id: "old",
				state: "paid",
				currency: "USD",
				createdAt: "2026-06-01T09:00:00.000Z", // before REPORTING_WINDOW
				totalCents: 5000,
			});
			await h.seedRefund({ orderId: "old", amountCents: 5000, currency: "USD" });
			expect(await h.store.revenueByPeriod(REPORTING_WINDOW, "day")).toEqual([]);
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
				{ sku: "SKU-A", onHand: 0, title: "Alpha Widget" },
				{ sku: "SKU-B", onHand: 3, title: null },
				{ sku: "SKU-C", onHand: 5, title: "Gamma Sprocket" },
				{ sku: "SKU-E", onHand: 5, title: null },
			]);
			expect(await store.lowStock(3)).toEqual([
				{ sku: "SKU-A", onHand: 0, title: "Alpha Widget" },
				{ sku: "SKU-B", onHand: 3, title: null },
			]);
			expect(await store.lowStock(0)).toEqual([{ sku: "SKU-A", onHand: 0, title: "Alpha Widget" }]);
		});

		test("lowStock carries the LIVE product title; a null product title stays null and is NEVER the sku", async () => {
			const { store } = await seeded();
			const rows = await store.lowStock(5);
			const bySku = new Map(rows.map((r) => [r.sku, r]));
			expect(bySku.get("SKU-A")?.title).toBe("Alpha Widget");
			// The product exists and is live, but its own title is null. The sku
			// must never be substituted — a renderer's `(untitled)` affordance
			// depends on telling these apart.
			expect(bySku.get("SKU-B")?.title).toBeNull();
			expect(bySku.get("SKU-B")?.title).not.toBe("SKU-B");
		});

		test("lowStock: a soft-deleted product sharing a live sku neither duplicates the row nor titles it", async () => {
			const { store } = await seeded();
			const rows = await store.lowStock(5);
			// SKU-C is claimed by one LIVE row and one tombstone (legal — live-sku
			// uniqueness is a PARTIAL index, so a soft delete frees the sku). The
			// join must be 1:1 against the live row only.
			expect(rows.filter((r) => r.sku === "SKU-C")).toHaveLength(1);
			expect(rows.find((r) => r.sku === "SKU-C")?.title).toBe("Gamma Sprocket");
			// SKU-E is claimed ONLY by a tombstone: the low-stock row still lists
			// (inventory is the driving table) but a dead product cannot title it.
			expect(rows.filter((r) => r.sku === "SKU-E")).toHaveLength(1);
			expect(rows.find((r) => r.sku === "SKU-E")?.title).toBeNull();
		});

		test("lowStock: a sku with no product row at all reports title null, never the sku", async () => {
			const h = await seeded();
			await h.seedInventory({ sku: "SKU-ORPHAN", onHand: 1 });
			const row = (await h.store.lowStock(5)).find((r) => r.sku === "SKU-ORPHAN");
			expect(row).toEqual({ sku: "SKU-ORPHAN", onHand: 1, title: null });
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
