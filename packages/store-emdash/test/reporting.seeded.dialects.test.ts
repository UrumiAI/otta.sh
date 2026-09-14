/**
 * Every bucket of the rollup adapter, for all three intervals, against a
 * FROM-SCRATCH computation of the same seed.
 *
 * The oracle is the domain's own `InMemoryReportingStore` — the IO-free adapter
 * that computes the four aggregates in plain JS over the rows, and the first
 * adapter the contract ever passed. Comparing against it rather than against
 * hand-written numbers is what makes this suite an EQUIVALENCE claim: the rollup
 * path (write-time counters, read-time fold over day documents) must agree with a
 * read-time scan on every bucket, every currency and every boundary, or the two
 * disagree and the seed says where.
 *
 * The seed is deliberately awkward where the boundaries are: a Sunday and the
 * Monday after it, the last day of a month and the first of the next, two
 * currencies on one day, a day whose only activity is a refund, a refund against
 * an order created long before the window, and a zero-total order in a
 * revenue-counting state (which is a bucket at `revenueCents: 0`, not an absent
 * one).
 */
import { InMemoryReportingStore } from "@otta-sh/domain/testing";
import type { DateRange, ReportInterval } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { isScanPageLimitError } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

interface SeedOrder {
	id: string;
	state: string;
	currency: string;
	createdAt: string;
	totalCents: number;
}

interface SeedRefund {
	orderId: string;
	amountCents: number;
	currency: string;
	status?: string;
}

/** 20 orders over two months, two currencies and both week boundaries. */
const SEED_ORDERS: SeedOrder[] = [
	// Sunday 2026-06-28 — the week of Mon 2026-06-22.
	{ id: "s1", state: "paid", currency: "USD", createdAt: "2026-06-28T23:59:59.999Z", totalCents: 1100 },
	// Monday 2026-06-29 — a new week, still June.
	{ id: "s2", state: "completed", currency: "USD", createdAt: "2026-06-29T00:00:00.000Z", totalCents: 2200 },
	{ id: "s3", state: "pending", currency: "USD", createdAt: "2026-06-29T06:00:00.000Z", totalCents: 9900 },
	// Tuesday 2026-06-30 — last day of the month, same week as s2.
	{ id: "s4", state: "shipped", currency: "EUR", createdAt: "2026-06-30T12:00:00.000Z", totalCents: 3300 },
	{ id: "s5", state: "refunded", currency: "EUR", createdAt: "2026-06-30T13:00:00.000Z", totalCents: 4400 },
	// Wednesday 2026-07-01 — new MONTH, same week as s2/s4.
	{ id: "s6", state: "delivered", currency: "USD", createdAt: "2026-07-01T00:00:00.001Z", totalCents: 5500 },
	{ id: "s7", state: "cancelled", currency: "USD", createdAt: "2026-07-01T10:00:00.000Z", totalCents: 6600 },
	{ id: "s8", state: "processing", currency: "EUR", createdAt: "2026-07-01T11:00:00.000Z", totalCents: 7700 },
	// Sunday 2026-07-05 / Monday 2026-07-06 — the second week split.
	{ id: "s9", state: "paid", currency: "USD", createdAt: "2026-07-05T22:00:00.000Z", totalCents: 1200 },
	{ id: "s10", state: "paid", currency: "USD", createdAt: "2026-07-06T02:00:00.000Z", totalCents: 1300 },
	{ id: "s11", state: "expired", currency: "EUR", createdAt: "2026-07-06T03:00:00.000Z", totalCents: 8800 },
	{ id: "s12", state: "failed", currency: "USD", createdAt: "2026-07-06T04:00:00.000Z", totalCents: 7000 },
	// A ZERO-total order in a revenue-counting state: a bucket at 0, never absent.
	{ id: "s13", state: "paid", currency: "GBP", createdAt: "2026-07-07T09:00:00.000Z", totalCents: 0 },
	// A day whose ONLY activity is a refund (the order is `refunded`, so no revenue).
	{ id: "s14", state: "refunded", currency: "USD", createdAt: "2026-07-08T09:00:00.000Z", totalCents: 2500 },
	// Several states on one day in one currency, so a state bucket holds more than 1.
	{ id: "s15", state: "paid", currency: "USD", createdAt: "2026-07-09T01:00:00.000Z", totalCents: 1000 },
	{ id: "s16", state: "paid", currency: "USD", createdAt: "2026-07-09T02:00:00.000Z", totalCents: 1000 },
	{ id: "s17", state: "pending", currency: "USD", createdAt: "2026-07-09T03:00:00.000Z", totalCents: 1000 },
	{ id: "s18", state: "pending", currency: "EUR", createdAt: "2026-07-09T04:00:00.000Z", totalCents: 1000 },
	// Outside every window asserted below — a refund against it must not leak in.
	{ id: "s19", state: "paid", currency: "USD", createdAt: "2026-05-01T09:00:00.000Z", totalCents: 4000 },
	// The last day of the widest window, so an inclusive `to` is exercised.
	{ id: "s20", state: "completed", currency: "EUR", createdAt: "2026-07-10T23:00:00.000Z", totalCents: 9100 },
];

const SEED_REFUNDS: SeedRefund[] = [
	// A partial against a still-`paid` order: revenue untouched, refund stated beside it.
	{ orderId: "s1", amountCents: 100, currency: "USD" },
	// Two rows on one order AGGREGATE rather than the last one winning.
	{ orderId: "s5", amountCents: 400, currency: "EUR" },
	{ orderId: "s5", amountCents: 4000, currency: "EUR" },
	// The refund carries its own currency; here it differs from nothing, but the
	// bucket it lands in is the ORDER's creation day, not the refund's own instant.
	{ orderId: "s14", amountCents: 2500, currency: "USD" },
	// Not finalized: capacity held or released, never money that came back.
	{ orderId: "s15", amountCents: 999, currency: "USD", status: "reserved" },
	{ orderId: "s16", amountCents: 888, currency: "USD", status: "unverified" },
	{ orderId: "s17", amountCents: 777, currency: "USD", status: "voided" },
	// An order OUTSIDE the asserted windows: its refund is outside them too.
	{ orderId: "s19", amountCents: 4000, currency: "USD" },
];

/** Every window the equivalence is asserted over. */
const WINDOWS: { name: string; range: DateRange }[] = [
	{
		name: "the whole seed",
		range: { from: "2026-06-22T00:00:00.000Z", to: "2026-07-10T23:59:59.999Z" },
	},
	{
		name: "a month boundary",
		range: { from: "2026-06-29T00:00:00.000Z", to: "2026-07-01T23:59:59.999Z" },
	},
	{
		name: "one day",
		range: { from: "2026-07-09T00:00:00.000Z", to: "2026-07-09T23:59:59.999Z" },
	},
	{
		name: "a window with no orders in it",
		range: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-21T23:59:59.999Z" },
	},
];

const INTERVALS: ReportInterval[] = ["day", "week", "month"];

/** The from-scratch oracle, seeded with the same rows. */
function oracle(): InMemoryReportingStore {
	const fake = new InMemoryReportingStore();
	for (const o of SEED_ORDERS) fake.seedOrder(o);
	for (const r of SEED_REFUNDS) fake.seedRefund(r);
	return fake;
}

async function seeded(h: ReportingHarness): Promise<ReportingHarness> {
	for (const o of SEED_ORDERS) await h.seedOrder(o);
	for (const r of SEED_REFUNDS) await h.seedRefund(r);
	return h;
}

describeEachDialect("EmdashReportingStore seeded aggregates", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);

	for (const window of WINDOWS) {
		describe(window.name, () => {
			for (const interval of INTERVALS) {
				test(`revenueByPeriod by ${interval} equals a from-scratch computation`, async () => {
					const h = await seeded(makeReportingHarness(bound.storage));
					expect(await h.store.revenueByPeriod(window.range, interval)).toEqual(
						await oracle().revenueByPeriod(window.range, interval),
					);
				});
			}

			test("ordersByStatus equals a from-scratch computation", async () => {
				const h = await seeded(makeReportingHarness(bound.storage));
				expect(await h.store.ordersByStatus(window.range)).toEqual(
					await oracle().ordersByStatus(window.range),
				);
			});
		});
	}

	test("a zero-total order in a revenue-counting state is a bucket at revenueCents 0", async () => {
		const h = await seeded(makeReportingHarness(bound.storage));
		const buckets = await h.store.revenueByPeriod(
			{ from: "2026-07-07T00:00:00.000Z", to: "2026-07-07T23:59:59.999Z" },
			"day",
		);
		expect(buckets).toEqual([
			{
				bucketStart: "2026-07-07T00:00:00.000Z",
				currency: "GBP",
				revenueCents: 0,
				refundedCents: 0,
			},
		]);
	});

	test("a refund on an order created in an EARLIER bucket lands in that earlier bucket", async () => {
		const h = await seeded(makeReportingHarness(bound.storage));
		// s1 was created on Sunday 2026-06-28 and refunded long afterwards; the 100
		// belongs to June 28, and to the week of Mon June 22 — never to the week the
		// refund was issued in.
		const days = await h.store.revenueByPeriod(
			{ from: "2026-06-28T00:00:00.000Z", to: "2026-07-10T23:59:59.999Z" },
			"day",
		);
		expect(days.find((b) => b.bucketStart === "2026-06-28T00:00:00.000Z")).toEqual({
			bucketStart: "2026-06-28T00:00:00.000Z",
			currency: "USD",
			revenueCents: 1100,
			refundedCents: 100,
		});
		const weeks = await h.store.revenueByPeriod(
			{ from: "2026-06-22T00:00:00.000Z", to: "2026-07-10T23:59:59.999Z" },
			"week",
		);
		expect(weeks.find((b) => b.bucketStart === "2026-06-22T00:00:00.000Z")).toEqual({
			bucketStart: "2026-06-22T00:00:00.000Z",
			currency: "USD",
			revenueCents: 1100,
			refundedCents: 100,
		});
	});

	test("two orders on DIFFERENT days sum into one month bucket, and no month document exists", async () => {
		const h = await seeded(makeReportingHarness(bound.storage));
		const july = await h.store.revenueByPeriod(
			{ from: "2026-07-01T00:00:00.000Z", to: "2026-07-10T23:59:59.999Z" },
			"month",
		);
		const usd = july.find((b) => b.currency === "USD");
		// 5500 (Jul 1) + 1200 (Jul 5) + 1300 (Jul 6) + 1000 + 1000 (Jul 9).
		expect(usd).toEqual({
			bucketStart: "2026-07-01T00:00:00.000Z",
			currency: "USD",
			revenueCents: 10_000,
			refundedCents: 2500,
		});
		// The month is a FOLD over day documents. Nothing keyed by a month exists.
		const ids = Object.keys(await h.dailyDocs());
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(id).toMatch(/^[A-Z]{3}:\d{4}-\d{2}-\d{2}$/);
	});

	describe("a window wider than one page", () => {
		/** 150 consecutive days, one order each — four+ pages at the host's 100 clamp. */
		const DAYS = 150;

		async function seedManyDays(h: ReportingHarness): Promise<number> {
			let total = 0;
			for (let day = 0; day < DAYS; day++) {
				const at = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString();
				const amount = 100 + day;
				total += amount;
				await h.seedOrder({
					id: `p${String(day)}`,
					state: "paid",
					currency: "USD",
					createdAt: at,
					totalCents: amount,
				});
			}
			return total;
		}

		test("sums across every page of day documents", async () => {
			const h = makeReportingHarness(bound.storage);
			const total = await seedManyDays(h);
			const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" };
			expect(Object.keys(await h.dailyDocs())).toHaveLength(DAYS);
			const days = await h.store.revenueByPeriod(range, "day");
			expect(days).toHaveLength(DAYS);
			expect(days.reduce((sum, b) => sum + b.revenueCents, 0)).toBe(total);
			// And the same total through the coarser folds, which must not lose a page.
			for (const interval of ["week", "month"] as ReportInterval[]) {
				const buckets = await h.store.revenueByPeriod(range, interval);
				expect(buckets.reduce((sum, b) => sum + b.revenueCents, 0)).toBe(total);
			}
			const statuses = await h.store.ordersByStatus(range);
			expect(statuses).toEqual([{ status: "paid", orderCount: DAYS }]);
		});

		test("a page budget too small to cover the window throws ScanPageLimitError, never a short answer", async () => {
			const h = makeReportingHarness(bound.storage);
			await seedManyDays(h);
			const tight = makeReportingHarness(bound.storage, { maxReportPages: 1, clock: h.clock });
			const failure = await tight.store
				.revenueByPeriod({ from: "2026-01-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" }, "day")
				.then(
					() => null,
					(err: unknown) => err,
				);
			expect(isScanPageLimitError(failure)).toBe(true);
			expect((failure as { budgetOption: string }).budgetOption).toBe("maxReportPages");
		});
	});
});
