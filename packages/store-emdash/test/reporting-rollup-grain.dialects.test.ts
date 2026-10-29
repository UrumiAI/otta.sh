/**
 * The month grain and the top-products lines (issue #572), against the day grain
 * and the order scan they replace.
 *
 * A long report reads a clean `reporting_monthly` document for every whole month
 * and top products from the product lines the day and month documents carry. Both
 * are caches BUILT from something else (the day documents; the orders), so this
 * suite is an equivalence claim on every path a reader can take:
 *
 * - nothing built (a store just upgraded): the coarse read falls back to the days,
 *   top products to the order scan;
 * - everything built: months and lines;
 * - built, then moved by refunds, cancellations and status changes: the moved months
 *   and days fall back until rebuilt, and agree again once they are.
 *
 * Every answer is compared with the day-only fold and with the order scan
 * `topProducts` was before #572, over ranges that start and end on month boundaries
 * to the millisecond, inside a day, and across a year.
 */
import type { DateRange, TopProduct } from "@urumi.ai/otta-domain";
import { describe, expect, test } from "vitest";
import {
	collectionOf,
	ORDERS_COLLECTION,
	PRODUCTS_UNBUILDABLE,
	REPORTING_APPLIED_COLLECTION,
	REPORTING_MONTHLY_FORMAT,
	REPORTING_DAILY_COLLECTION,
	REPORTING_MONTHLY_COLLECTION,
	REVENUE_STATES,
	type OrderDoc,
	type ReportingAppliedDoc,
	type ReportingDailyStoredDoc,
	type ReportingMonthlyDoc,
	type StorageAccess,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

const CURRENCIES = ["USD", "EUR", "JPY"] as const;
const STATES = ["paid", "pending", "completed", "shipped", "cancelled", "refunded", "processing"];
const PRODUCTS = [
	{ productId: "p-mug", title: "Mug" },
	{ productId: "p-mug", title: "Mug (old title)" },
	{ productId: "p-tee", title: "Tee" },
	{ productId: "p-cap", title: "Cap" },
] as const;

/** Far enough ahead that every seeded day is closed, for the refresh's own lists. */
const FUTURE_DAY = "2100-01-01";

/** The ranges every case is asked over. */
const RANGES: readonly { name: string; range: DateRange }[] = [
	{
		name: "whole months, boundary to boundary",
		range: { from: "2026-04-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z" },
	},
	{
		name: "everything, partial months at both ends",
		range: { from: "2026-02-20T00:00:00.000Z", to: "2026-07-09T23:59:59.999Z" },
	},
	{
		name: "ragged instants inside the edge days",
		range: { from: "2026-03-15T12:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
	},
	{
		name: "the last millisecond of March to the first of May",
		range: { from: "2026-03-31T23:59:59.999Z", to: "2026-05-01T00:00:00.000Z" },
	},
	{
		name: "a single whole month",
		range: { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" },
	},
	{
		name: "a year, more months than the seed has",
		range: { from: "2025-07-10T00:00:00.000Z", to: "2026-07-09T23:59:59.999Z" },
	},
];

/** The seeded order ids, for the transitions the moving cases make. */
interface Seeded {
	readonly ids: readonly string[];
}

/**
 * ~130 orders from March to early July in three currencies and every state, one or
 * two lines each over four products (one sold under two titles), with orders at the
 * first and last millisecond of each month and finalized refunds on some.
 */
async function seed(h: ReportingHarness): Promise<Seeded> {
	const ids: string[] = [];
	const start = Date.parse("2026-03-01T00:00:00.000Z");
	for (let i = 0; i < 130; i++) {
		const id = `o${String(i)}`;
		// Every 13th order sits on a month's last or first millisecond.
		let createdAt = new Date(start + i * 0.95 * 86_400_000 + (i % 24) * 3_600_000).toISOString();
		if (i % 13 === 0) createdAt = `2026-0${String(3 + (i % 4))}-01T00:00:00.000Z`;
		if (i % 13 === 1) {
			const month = 3 + (i % 4);
			const last = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10);
			createdAt = `${last}T23:59:59.999Z`;
		}
		if (createdAt >= "2026-07-10") createdAt = "2026-07-09T08:00:00.000Z";
		const currency = CURRENCIES[i % 3]!;
		const state = STATES[i % STATES.length]!;
		const lines = [PRODUCTS[i % 4]!, ...(i % 3 === 0 ? [PRODUCTS[(i + 1) % 4]!] : [])];
		const unit = currency === "JPY" ? 1500 : 1999;
		const total = lines.reduce((sum, _line, k) => sum + unit * (1 + k), 0);
		await h.seedOrder({ id, state, currency, createdAt, totalCents: total });
		for (const [k, line] of lines.entries()) {
			await h.seedOrderItem({
				orderId: id,
				productId: line.productId,
				title: line.title,
				unitPriceCents: unit,
				quantity: 1 + k,
			});
		}
		if (i % 5 === 0) await h.seedRefund({ orderId: id, amountCents: 300, currency });
		ids.push(id);
	}
	return { ids };
}

/** Every order document, for the oracle. */
async function allOrders(h: ReportingHarness): Promise<OrderDoc[]> {
	const out: OrderDoc[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await h.orders.query({ limit: 100, cursor });
		for (const { data } of page.items) out.push(data);
		if (!page.hasMore || page.cursor === undefined) return out;
		cursor = page.cursor;
	}
}

/** `topProducts` as it was before #572: one scan of the window's orders, grouped. */
async function scannedTop(
	h: ReportingHarness,
	range: DateRange,
	metric: "revenue" | "quantity",
): Promise<TopProduct[]> {
	const groups = new Map<string, TopProduct>();
	for (const order of await allOrders(h)) {
		if (order.createdAt < range.from || order.createdAt > range.to) continue;
		if (!REVENUE_STATES.has(order.state)) continue;
		for (const item of order.items) {
			const key = `${item.productId}|${item.title}`;
			const held = groups.get(key);
			groups.set(key, {
				productId: item.productId,
				titleSnapshot: item.title,
				qtySold: (held?.qtySold ?? 0) + item.quantity,
				revenueCents: ((held?.revenueCents ?? 0) + item.quantity * item.unitPrice) as never,
			});
		}
	}
	return [...groups.values()].toSorted((a, b) => {
		const av = metric === "quantity" ? a.qtySold : a.revenueCents;
		const bv = metric === "quantity" ? b.qtySold : b.revenueCents;
		if (bv !== av) return bv - av;
		const [x, y] =
			a.productId === b.productId ? [a.titleSnapshot, b.titleSnapshot] : [a.productId, b.productId];
		return x < y ? -1 : x > y ? 1 : 0;
	});
}

/** Day buckets folded to months in the test: the day-only answer to a month bucketing. */
async function monthsFromDays(h: ReportingHarness, range: DateRange) {
	const months = new Map<
		string,
		{ revenueCents: number; revenueOrderCount: number; refundedCents: number }
	>();
	for (const b of await h.store.revenueByPeriod(range, "day")) {
		const key = `${b.bucketStart.slice(0, 7)}-01T00:00:00.000Z|${b.currency}`;
		const held = months.get(key) ?? { revenueCents: 0, revenueOrderCount: 0, refundedCents: 0 };
		held.revenueCents += b.revenueCents;
		held.revenueOrderCount += b.revenueOrderCount;
		held.refundedCents += b.refundedCents;
		months.set(key, held);
	}
	return [...months.entries()]
		.toSorted((a, b) => a[0].localeCompare(b[0]))
		.map(([key, sums]) => {
			const [bucketStart, currency] = key.split("|") as [string, string];
			return { bucketStart, currency, ...sums };
		});
}

/** Every answer a report can give over a range, for one comparison. */
async function answers(h: ReportingHarness, range: DateRange) {
	const [month, statuses, topRevenue, topQuantity] = await Promise.all([
		h.store.revenueByPeriod(range, "month"),
		h.store.ordersByStatus(range),
		h.store.topProducts(range, "revenue", 1000),
		h.store.topProducts(range, "quantity", 1000),
	]);
	return {
		month: month.map((b) => ({
			bucketStart: b.bucketStart,
			currency: b.currency as string,
			revenueCents: b.revenueCents as number,
			revenueOrderCount: b.revenueOrderCount,
			refundedCents: b.refundedCents as number,
		})),
		statuses,
		topRevenue,
		topQuantity,
	};
}

/** The day-only and order-scan oracle for the same range. */
async function oracle(h: ReportingHarness, range: DateRange) {
	const statuses = new Map<string, number>();
	for (const order of await allOrders(h)) {
		if (order.createdAt < range.from || order.createdAt > range.to) continue;
		statuses.set(order.state, (statuses.get(order.state) ?? 0) + 1);
	}
	return {
		month: await monthsFromDays(h, range),
		statuses: [...statuses.entries()]
			.toSorted((a, b) => a[0].localeCompare(b[0]))
			.map(([status, orderCount]) => ({ status, orderCount })),
		topRevenue: await scannedTop(h, range, "revenue"),
		topQuantity: await scannedTop(h, range, "quantity"),
	};
}

/** What the cron's refresh does, to the end: every day's lines, then every month. */
async function settle(h: ReportingHarness): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const days = await h.store.staleProductDays(FUTURE_DAY, 100);
		if (days.length === 0) break;
		for (const day of days) await h.store.rebuildDayProducts(day);
	}
	for (const month of await h.store.staleMonths("2100-01", 100)) {
		expect(await h.store.rebuildMonth(month)).toBe(true);
	}
}

/** A storage whose `orders` queries are counted. */
function countingOrders(storage: StorageAccess): { storage: StorageAccess; scans: () => number } {
	let scans = 0;
	const orders = storage[ORDERS_COLLECTION]!;
	const counted = new Proxy(orders, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (prop === "query") scans++;
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return { storage: { ...storage, [ORDERS_COLLECTION]: counted }, scans: () => scans };
}

describeEachDialect("EmdashReportingStore month grain and product lines (#572)", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);

	const monthly = () =>
		collectionOf<ReportingMonthlyDoc>(bound.storage, REPORTING_MONTHLY_COLLECTION);
	const dailyRaw = () =>
		collectionOf<ReportingDailyStoredDoc>(bound.storage, REPORTING_DAILY_COLLECTION);

	describe("nothing built, everything built, and moved after building all agree with the days and the scan", () => {
		for (const { name, range } of RANGES) {
			test(name, async () => {
				const h = makeReportingHarness(bound.storage);
				const seeded = await seed(h);

				// Nothing built: every month dirty, every paid day's lines dirty.
				expect(await answers(h, range)).toEqual(await oracle(h, range));

				await settle(h);
				expect(await answers(h, range)).toEqual(await oracle(h, range));

				// Move orders of old, built months: refunds, cancellations, status changes.
				for (const [k, id] of seeded.ids.entries()) {
					if (k % 9 !== 0) continue;
					const order = (await h.orders.get(id))!;
					if (order.state === "paid") await h.transitionOrder(id, "refunded");
					else if (order.state === "pending") await h.transitionOrder(id, "paid");
					else if (order.state === "processing") await h.transitionOrder(id, "cancelled");
					else if (order.state === "shipped") await h.transitionOrder(id, "delivered");
					else await h.refundOrder(id, 111);
				}
				// Before the refresh: moved months and days fall back, and still agree.
				expect(await answers(h, range)).toEqual(await oracle(h, range));
				await settle(h);
				expect(await answers(h, range)).toEqual(await oracle(h, range));
			});
		}
	});

	test("a built month document is exactly the sum of its day documents", async () => {
		const h = makeReportingHarness(bound.storage);
		await seed(h);
		await settle(h);
		const may = await monthly().get("2026-05");
		expect(may).toMatchObject({ month: "2026-05", dirty: 0 });
		const sums = new Map<string, { revenueCents: number; refundedCents: number; orders: number }>();
		const page = await h.daily.query({
			where: { date: { gte: "2026-05-01", lte: "2026-05-31" } },
			limit: 100,
		});
		for (const { data } of page.items) {
			const held = sums.get(data.currency) ?? { revenueCents: 0, refundedCents: 0, orders: 0 };
			held.revenueCents += data.revenueCents;
			held.refundedCents += data.refundedCents;
			held.orders += Object.values(data.stateCounts).reduce((a, b) => a + b, 0);
			sums.set(data.currency, held);
		}
		expect(Object.keys(may!.currencies!).toSorted()).toEqual([...sums.keys()].toSorted());
		for (const [currency, sum] of sums) {
			const held = may!.currencies![currency]!;
			expect(held.revenueCents).toBe(sum.revenueCents);
			expect(held.refundedCents).toBe(sum.refundedCents);
			expect(Object.values(held.stateCounts).reduce((a, b) => a + b, 0)).toBe(sum.orders);
			expect(held.products).not.toBeNull();
		}
	});

	test("an order entering or leaving the revenue set dirties its day's lines and its month; a status move inside it only the month", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "a",
			state: "paid",
			currency: "USD",
			createdAt: "2026-05-10T10:00:00.000Z",
			totalCents: 1000,
		});
		await h.seedOrderItem({
			orderId: "a",
			productId: "p",
			title: "P",
			unitPriceCents: 1000,
			quantity: 1,
		});
		await settle(h);
		expect(await dailyRaw().get("USD:2026-05-10")).toMatchObject({ productsDirty: 0 });
		expect(await monthly().get("2026-05")).toMatchObject({ dirty: 0 });

		await h.transitionOrder("a", "shipped");
		expect(await dailyRaw().get("USD:2026-05-10")).toMatchObject({ productsDirty: 0 });
		expect(await monthly().get("2026-05")).toMatchObject({ dirty: 1 });
		await settle(h);

		await h.transitionOrder("a", "refunded");
		expect(await dailyRaw().get("USD:2026-05-10")).toMatchObject({ productsDirty: 1 });
		expect(await monthly().get("2026-05")).toMatchObject({ dirty: 1 });
		const range = { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" };
		expect(await h.store.topProducts(range, "revenue", 10)).toEqual([]);
		await settle(h);
		expect(await dailyRaw().get("USD:2026-05-10")).toMatchObject({
			productsDirty: 0,
			products: [],
		});
		expect(await h.store.topProducts(range, "revenue", 10)).toEqual([]);
	});

	test("once built, a year's top products scan no orders, and a store just upgraded scans them as it always did", async () => {
		const seeded = makeReportingHarness(bound.storage);
		await seed(seeded);
		const counting = countingOrders(bound.storage);
		const h = makeReportingHarness(bound.storage, {
			clock: seeded.clock,
			storageForStore: counting.storage,
		});
		const year = RANGES.at(-1)!.range;

		// UPGRADED: strip every day document back to what it held before #572.
		let cursor: string | undefined;
		do {
			const page = await dailyRaw().query({ limit: 100, cursor });
			for (const { id, data } of page.items) {
				const { products: _p, productsDirty: _d, ...legacy } = data;
				await dailyRaw().put(id, legacy);
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);
		cursor = undefined;
		do {
			const page = await monthly().query({ limit: 100, cursor });
			for (const { id } of page.items) await monthly().delete(id);
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);

		const want = await scannedTop(seeded, year, "revenue");
		const before = counting.scans();
		expect(await h.store.topProducts(year, "revenue", 1000)).toEqual(want);
		expect(counting.scans() - before).toBeGreaterThan(0);

		// The refresh finds every one of them: the backfill.
		expect((await h.store.staleProductDays(FUTURE_DAY, 1000)).length).toBeGreaterThan(80);
		await settle(h);
		expect(await h.store.staleProductDays(FUTURE_DAY, 1000)).toEqual([]);
		const settled = counting.scans();
		expect(await h.store.topProducts(year, "revenue", 1000)).toEqual(want);
		expect(counting.scans()).toBe(settled);
	});

	test("a rebuild whose days move under it does not commit as clean", async () => {
		const h = makeReportingHarness(bound.storage);
		await seed(h);
		await settle(h);
		await h.transitionOrder(
			"o40",
			(await h.orders.get("o40"))!.state === "paid" ? "refunded" : "paid",
		);
		const month = (await h.orders.get("o40"))!.createdAt.slice(0, 7);
		expect(await monthly().get(month)).toMatchObject({ dirty: 1 });

		// A live event lands while the rebuild reads the month's days.
		let fired = false;
		const daily = bound.storage[REPORTING_DAILY_COLLECTION]!;
		const racing = new Proxy(daily, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
					if (prop === "query" && !fired) {
						fired = true;
						await h.refundOrder("o40", 50);
					}
					return result;
				};
			},
		});
		const twin = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: { ...bound.storage, [REPORTING_DAILY_COLLECTION]: racing },
			maxCasAttempts: 1,
		});
		await expect(twin.store.rebuildMonth(month)).rejects.toMatchObject({
			name: "StorageContentionError",
		});
		expect(fired).toBe(true);
		expect(await monthly().get(month)).toMatchObject({ dirty: 1 });

		// The next rebuild reads the refund.
		expect(await h.store.rebuildMonth(month)).toBe(true);
		const range = { from: `${month}-01T00:00:00.000Z`, to: `${month}-28T23:59:59.999Z` };
		expect(await answers(h, range)).toEqual(await oracle(h, range));
	});

	test("an event that dies between its claim and its stamp holds the month off until its day is recomputed", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "c",
			state: "pending",
			currency: "USD",
			createdAt: "2026-05-10T10:00:00.000Z",
			totalCents: 2500,
		});
		await settle(h);
		// The order moves; its rollup event claims, dirties the month, and dies before the day.
		const event = await h.moveOrderDocument("c", "paid");
		const daily = bound.storage[REPORTING_DAILY_COLLECTION]!;
		const dying = new Proxy(daily, {
			get(target, prop, receiver) {
				if (prop === "updateIf") {
					return async () => {
						throw new Error("crash");
					};
				}
				const value: unknown = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const crashing = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: { ...bound.storage, [REPORTING_DAILY_COLLECTION]: dying },
		});
		await expect(crashing.store.recordOrderEvent(event)).rejects.toThrow("crash");
		expect(await monthly().get("2026-05")).toMatchObject({ dirty: 1 });

		// Unstamped: the rebuild will not build over it.
		expect(await h.store.rebuildMonth("2026-05")).toBe(false);
		expect(await h.store.unstampedClaimDays("2026-05", FUTURE_DAY, 10)).toEqual(["2026-05-10"]);
		// Not yet settled long enough to be called a crash.
		expect(await h.store.unstampedClaimDays("2026-05", "2026-01-01T00:00:00.000Z", 10)).toEqual([]);

		// The recompute absorbs the claim (stamping it) and counts the order.
		await h.store.reconcile({ from: "2026-05-10T00:00:00.000Z", to: "2026-05-10T23:59:59.999Z" });
		expect(await h.store.rebuildMonth("2026-05")).toBe(true);
		const may = { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" };
		expect(await h.store.revenueByPeriod(may, "month")).toMatchObject([
			{ bucketStart: "2026-05-01T00:00:00.000Z", revenueCents: 2500, revenueOrderCount: 1 },
		]);
	});

	test("a dirty month is never read: the coarse read takes its days", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "d",
			state: "paid",
			currency: "EUR",
			createdAt: "2026-04-15T10:00:00.000Z",
			totalCents: 700,
		});
		await settle(h);
		// Tamper with the built sums, then dirty the month as any day write would.
		const held = (await monthly().get("2026-04"))!;
		await monthly().put("2026-04", {
			...held,
			currencies: { EUR: { ...held.currencies!.EUR!, revenueCents: 999_999 } },
		});
		const april = { from: "2026-04-01T00:00:00.000Z", to: "2026-04-30T23:59:59.999Z" };
		// Clean: the month document IS what is read.
		expect((await h.store.revenueByPeriod(april, "month"))[0]?.revenueCents).toBe(999_999);
		await h.refundOrder("d", 100);
		// Dirty: the days are.
		expect(await h.store.revenueByPeriod(april, "month")).toMatchObject([
			{ revenueCents: 700, refundedCents: 100 },
		]);
	});
});

/** A value with every object's keys in Postgres jsonb's order: shorter first, then bytewise. */
function jsonbOrder<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v: unknown) => jsonbOrder(v)) as T;
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
		a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0,
	);
	return Object.fromEntries(entries.map(([k, v]) => [k, jsonbOrder(v)])) as T;
}

/** The settle window the sweep passes a rebuild (`REPORTING_SETTLE_MS` in the plugin). */
const SETTLE_MS = 20 * 60_000;

/** A storage whose collection `name` runs `before(method)` ahead of each call, and may throw. */
function intercept(
	storage: StorageAccess,
	name: string,
	before: (method: string) => Promise<void> | void,
): StorageAccess {
	const inner = storage[name]!;
	const wrapped = new Proxy(inner, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				await before(String(prop));
				return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
			};
		},
	});
	return { ...storage, [name]: wrapped };
}

/** One order with one line, for the cases that need a single known day. */
async function oneOrder(h: ReportingHarness, id: string, state: string, at: string) {
	await h.seedOrder({ id, state, currency: "USD", createdAt: at, totalCents: 2000 });
	await h.seedOrderItem({
		orderId: id,
		productId: `p-${id}`,
		title: `P ${id}`,
		unitPriceCents: 2000,
		quantity: 1,
	});
}

describeEachDialect("EmdashReportingStore month cache: the review's holes (#572)", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);
	const monthly = () =>
		collectionOf<ReportingMonthlyDoc>(bound.storage, REPORTING_MONTHLY_COLLECTION);
	const dailyRaw = () =>
		collectionOf<ReportingDailyStoredDoc>(bound.storage, REPORTING_DAILY_COLLECTION);
	const may = { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" };

	describe("the verifier: a clean cache that is wrong is repaired by a rebuild", () => {
		test("a corrupted clean month is rebuilt from its days, and an intact one is not written", async () => {
			const h = makeReportingHarness(bound.storage);
			await seed(h);
			await settle(h);
			const held = (await monthly().getVersioned("2026-05"))!;
			// Intact: the rebuild finds nothing to change and writes nothing.
			expect(await h.store.buildMonth("2026-05")).toBe("unchanged");
			expect((await monthly().getVersioned("2026-05"))!.revision).toBe(held.revision);

			// Corrupt it while it stays CLEAN: nothing about it says it is wrong.
			const usd = held.value.currencies!.USD!;
			await monthly().put("2026-05", {
				...held.value,
				currencies: {
					...held.value.currencies,
					USD: { ...usd, revenueCents: usd.revenueCents + 12_345, products: [] },
				},
			});
			expect(await answers(h, may)).not.toEqual(await oracle(h, may));
			expect(await h.store.buildMonth("2026-05")).toBe("repaired");
			expect(await answers(h, may)).toEqual(await oracle(h, may));
		});

		test("corrupted clean day lines are rebuilt from the day's orders, and counted as a repair", async () => {
			const h = makeReportingHarness(bound.storage);
			await oneOrder(h, "v1", "paid", "2026-05-12T09:00:00.000Z");
			await settle(h);
			const doc = (await dailyRaw().get("USD:2026-05-12"))!;
			expect(doc.productsDirty).toBe(0);
			await dailyRaw().put("USD:2026-05-12", { ...doc, products: [] });
			const day = { from: "2026-05-12T00:00:00.000Z", to: "2026-05-12T23:59:59.999Z" };
			expect(await h.store.topProducts(day, "revenue", 10)).toEqual([]);

			expect(await h.store.rebuildDayProducts("2026-05-12")).toMatchObject({
				written: 1,
				repaired: 1,
			});
			expect(await h.store.topProducts(day, "revenue", 10)).toEqual(
				await scannedTop(h, day, "revenue"),
			);
			// And again: nothing left to repair.
			expect(await h.store.rebuildDayProducts("2026-05-12")).toMatchObject({ repaired: 0 });
		});
	});

	test("a cache that comes back with its keys reordered (Postgres jsonb) is still unchanged", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "k1", "paid", "2026-05-12T09:00:00.000Z");
		await settle(h);
		// Postgres round-trips a guarded write through jsonb, which orders object keys by
		// length then bytes: the same document, read back in another key order.
		const month = (await monthly().get("2026-05"))!;
		await monthly().put("2026-05", jsonbOrder(month));
		const day = (await dailyRaw().get("USD:2026-05-12"))!;
		await dailyRaw().put("USD:2026-05-12", jsonbOrder(day));
		expect(Object.keys((await dailyRaw().get("USD:2026-05-12"))!.products![0]!)).toEqual([
			"qty",
			"cents",
			"title",
			"productId",
		]);
		expect(await h.store.buildMonth("2026-05")).toBe("unchanged");
		expect(await h.store.rebuildDayProducts("2026-05-12")).toMatchObject({
			written: 0,
			repaired: 0,
		});
	});

	test("(a) a recompute that stamps a live event's claim and dies does not let a rebuild bless the day without that event", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "a1", "pending", "2026-05-10T10:00:00.000Z");
		await settle(h);
		const event = await h.moveOrderDocument("a1", "paid");

		// E: claimed and touched; before its delta lands, a recompute R absorbs E's claim
		// (stamping it) and dies before writing anything, and a rebuild then sees no
		// unstamped claim and commits the month clean from days that lack E.
		let interleaved = false;
		const live = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: intercept(bound.storage, REPORTING_DAILY_COLLECTION, async (method) => {
				if (method !== "updateIf" || interleaved) return;
				interleaved = true;
				const dying = makeReportingHarness(bound.storage, {
					clock: h.clock,
					storageForStore: intercept(bound.storage, REPORTING_MONTHLY_COLLECTION, () => {
						throw new Error("recompute crashed");
					}),
				});
				await expect(
					dying.store.reconcile({
						from: "2026-05-10T00:00:00.000Z",
						to: "2026-05-10T23:59:59.999Z",
					}),
				).rejects.toThrow("recompute crashed");
				expect(await h.store.buildMonth("2026-05")).toBe("built");
				expect(await monthly().get("2026-05")).toMatchObject({ dirty: 0 });
			}),
		});
		await live.store.recordOrderEvent(event);
		expect(interleaved).toBe(true);

		// E's delta landed after that rebuild, and its stamp was refused (R stamped it):
		// E touched the month again, so the rebuild's blessing is undone.
		expect(await monthly().get("2026-05")).toMatchObject({ dirty: 1 });
		expect(await answers(h, may)).toEqual(await oracle(h, may));
		await settle(h);
		expect(await answers(h, may)).toEqual(await oracle(h, may));
		expect((await h.store.revenueByPeriod(may, "month"))[0]).toMatchObject({
			revenueCents: 2000,
			revenueOrderCount: 1,
		});
	});

	test("(b) a sweep writer that dies between its day write and its second touch holds the month off until the settle window has passed", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "b1", "paid", "2026-05-20T10:00:00.000Z");
		await settle(h);
		// Make the day's lines stale, so the product build writes.
		await dailyRaw().put("USD:2026-05-20", {
			...(await dailyRaw().get("USD:2026-05-20"))!,
			productsDirty: 1,
		});
		h.advance(SETTLE_MS * 2);
		const settled = () => new Date(h.clock.now().getTime() - SETTLE_MS).toISOString();

		// W: touches the month, and before its day write a rebuild B starts — after W's
		// touch, so B's `gen` pin does not see it. W writes the day, then dies before its
		// second touch. B must not have committed the month clean.
		let touches = 0;
		let raced: string | undefined;
		const dying = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: intercept(
				intercept(bound.storage, REPORTING_MONTHLY_COLLECTION, (method) => {
					if (method === "updateIf" && ++touches === 2) throw new Error("writer crashed");
				}),
				REPORTING_DAILY_COLLECTION,
				async (method) => {
					if (method !== "updateIf" || raced !== undefined) return;
					raced = await h.store.buildMonth("2026-05", { touchedBefore: settled() });
				},
			),
		});
		await expect(dying.store.rebuildDayProducts("2026-05-20")).rejects.toThrow("writer crashed");
		expect(raced).toBe("settling");
		expect(await monthly().get("2026-05")).toMatchObject({ dirty: 1 });

		// Still inside the window: refused again, and `staleMonths` does not list it.
		expect(await h.store.buildMonth("2026-05", { touchedBefore: settled() })).toBe("settling");
		expect(await h.store.staleMonths("2100-01", 10, settled())).toEqual([]);
		// Past it: built, from days that include W's write.
		h.advance(SETTLE_MS + 1);
		expect(await h.store.staleMonths("2100-01", 10, settled())).toEqual(["2026-05"]);
		expect(await h.store.buildMonth("2026-05", { touchedBefore: settled() })).toBe("built");
		expect(await answers(h, may)).toEqual(await oracle(h, may));
	});

	test("(c) lines built at an epoch a writer unaware of lines has moved past are not trusted", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "c1", "paid", "2026-05-14T10:00:00.000Z");
		await settle(h);
		const doc = (await dailyRaw().get("USD:2026-05-14"))!;
		// A recompute from a build older than #572: it bumps the epoch and rewrites the
		// counters, and knows nothing of `products` — which it leaves as they were.
		await dailyRaw().put("USD:2026-05-14", {
			...doc,
			epoch: doc.epoch! + 1,
			products: [{ productId: "ghost", title: "Ghost", qty: 9, cents: 9 }],
		});
		const day = { from: "2026-05-14T00:00:00.000Z", to: "2026-05-14T23:59:59.999Z" };
		expect(await h.store.topProducts(day, "revenue", 10)).toEqual(
			await scannedTop(h, day, "revenue"),
		);
		// A month rebuild that reads it flags it dirty, so the refresh lists it again.
		expect(await h.store.staleProductDays(FUTURE_DAY, 10)).not.toContain("2026-05-14");
		await h.store.buildMonth("2026-05");
		expect(await dailyRaw().get("USD:2026-05-14")).toMatchObject({ productsDirty: 1 });
		expect(await h.store.staleProductDays(FUTURE_DAY, 10)).toContain("2026-05-14");
		// And the build repairs it.
		expect(await h.store.rebuildDayProducts("2026-05-14")).toMatchObject({ written: 1 });
		expect(await dailyRaw().get("USD:2026-05-14")).toMatchObject({
			productsEpoch: doc.epoch! + 1,
		});
	});

	test("a month whose lines pass the cap keeps its counters and drops its lines; top products read its days", async () => {
		const h = makeReportingHarness(bound.storage, { maxMonthProductLines: 3 });
		for (let i = 0; i < 6; i++) {
			await oneOrder(h, `cap${String(i)}`, "paid", `2026-05-${String(10 + i)}T10:00:00.000Z`);
		}
		await settle(h);
		const doc = (await monthly().get("2026-05"))!;
		expect(doc).toMatchObject({ dirty: 0, format: REPORTING_MONTHLY_FORMAT });
		expect(doc.currencies!.USD).toMatchObject({ revenueCents: 12_000, products: null });
		expect(await answers(h, may)).toEqual(await oracle(h, may));
	});

	test("a day document created by a live event starts with its lines unknown", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "n1", "pending", "2026-05-16T10:00:00.000Z");
		const created = (await dailyRaw().get("USD:2026-05-16"))!;
		expect(created.productsDirty).toBeUndefined();
		expect(created.products).toBeUndefined();
		expect(await h.store.staleProductDays(FUTURE_DAY, 10)).toContain("2026-05-16");
	});

	test("an unbuildable day is not listed again, and its top products are still answered", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "u1", "paid", "2026-05-18T10:00:00.000Z");
		expect(await h.store.markProductsUnbuildable("2026-05-18")).toBe(1);
		expect(await dailyRaw().get("USD:2026-05-18")).toMatchObject({
			productsDirty: PRODUCTS_UNBUILDABLE,
		});
		expect(await h.store.staleProductDays(FUTURE_DAY, 10)).not.toContain("2026-05-18");
		expect(await h.store.dayOrderCount("2026-05-18")).toBe(1);
		expect(await answers(h, may)).toEqual(await oracle(h, may));
	});

	test("a claim no recompute can prove is stamped once settled, and stops holding its month", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "s1", "paid", "2026-05-22T10:00:00.000Z");
		await settle(h);
		// A claim for a transition the order never shows, left unstamped by a crash.
		const applied = collectionOf<ReportingAppliedDoc>(bound.storage, REPORTING_APPLIED_COLLECTION);
		await applied.put("orphan-claim", {
			orderId: "s1",
			kind: "transition",
			date: "2026-05-22",
			currency: "USD",
			fromState: "paid",
			toState: "shipped",
			refundId: null,
			amountCents: null,
			claimedAt: h.now(),
			appliedAt: null,
			absorbedAt: null,
		});
		await monthly().put("2026-05", { ...(await monthly().get("2026-05"))!, dirty: 1 });
		await h.store.reconcile({ from: "2026-05-22T00:00:00.000Z", to: "2026-05-22T23:59:59.999Z" });
		expect(await h.store.buildMonth("2026-05")).toBe("held");

		// Not settled yet: left alone.
		expect(await h.store.stampSettledClaims("2026-05-22", h.now(), 10)).toEqual({
			stamped: 0,
			more: false,
		});
		h.advance(SETTLE_MS + 1);
		const settled = new Date(h.clock.now().getTime() - SETTLE_MS).toISOString();
		expect(await h.store.stampSettledClaims("2026-05-22", settled, 10)).toEqual({
			stamped: 1,
			more: false,
		});
		expect(await applied.get("orphan-claim")).toMatchObject({ absorbedAt: null });
		expect(await h.store.buildMonth("2026-05")).toBe("built");
	});

	test("stamping settled claims is bounded per call, and the next call carries on", async () => {
		const h = makeReportingHarness(bound.storage);
		await oneOrder(h, "sb1", "paid", "2026-05-23T10:00:00.000Z");
		await settle(h);
		const applied = collectionOf<ReportingAppliedDoc>(bound.storage, REPORTING_APPLIED_COLLECTION);
		for (const id of ["orphan-a", "orphan-b", "orphan-c"]) {
			await applied.put(id, {
				orderId: "sb1",
				kind: "transition",
				date: "2026-05-23",
				currency: "USD",
				fromState: "paid",
				toState: id,
				refundId: null,
				amountCents: null,
				claimedAt: h.now(),
				appliedAt: null,
				absorbedAt: null,
			});
		}
		h.advance(SETTLE_MS + 1);
		const settled = new Date(h.clock.now().getTime() - SETTLE_MS).toISOString();
		expect(await h.store.stampSettledClaims("2026-05-23", settled, 2)).toEqual({
			stamped: 2,
			more: true,
		});
		expect(await h.store.stampSettledClaims("2026-05-23", settled, 2)).toEqual({
			stamped: 1,
			more: false,
		});
		expect(await applied.count({ date: "2026-05-23", appliedAt: null })).toBe(0);
	});

	test("the backfill lists the newest days first", async () => {
		const h = makeReportingHarness(bound.storage);
		for (const [i, day] of ["2026-03-03", "2026-05-05", "2026-04-04"].entries()) {
			await oneOrder(h, `nf${String(i)}`, "paid", `${day}T10:00:00.000Z`);
		}
		expect(await h.store.staleProductDays(FUTURE_DAY, 2)).toEqual(["2026-05-05", "2026-04-04"]);
	});

	test("the verifier's walk: months and days in order after a cursor, and none past the end", async () => {
		const h = makeReportingHarness(bound.storage);
		for (const [i, day] of ["2026-03-03", "2026-04-04", "2026-05-05"].entries()) {
			await oneOrder(h, `w${String(i)}`, "paid", `${day}T10:00:00.000Z`);
		}
		await settle(h);
		expect(await h.store.monthsAfter(null, "2026-06", 2)).toEqual(["2026-03", "2026-04"]);
		expect(await h.store.monthsAfter("2026-04", "2026-06", 2)).toEqual(["2026-05"]);
		expect(await h.store.monthsAfter("2026-05", "2026-06", 2)).toEqual([]);
		// Days newest first, as the backfill builds them.
		expect(await h.store.dayBefore(null, "2026-06-01")).toBe("2026-05-05");
		expect(await h.store.dayBefore("2026-05-05", "2026-06-01")).toBe("2026-04-04");
		expect(await h.store.dayBefore("2026-03-03", "2026-06-01")).toBeNull();
	});
});
