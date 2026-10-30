import {
	EmdashReportingStore,
	ORDERS_COLLECTION,
	systemClock,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import { createReportsPageHandler } from "../src/admin/reports-page.js";
import { presetRange, previousPeriod, shiftDay } from "../src/admin/reports-period.js";
import type { BlockResponse, PluginContext } from "../src/types.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

/**
 * The Reports page's STORAGE-READ budget on a year-long range, over a real
 * document store whose every call is counted.
 *
 * The page asked for a second full order scan (the units ranking) on a
 * multi-currency store, doubling the cost of the one report that is not a rollup
 * read. The units top ten is now a re-rank of the one full product list that
 * single read returns, so a multi-currency period scans the orders once.
 *
 * Workers Free allows 50 queries per invocation, and a page over that fails
 * closed to "Reports are unavailable" (issue #572). The large-store case below
 * is the shape a reviewer measured: two currencies with a rollup document on
 * every day of both periods, and 3,000 orders in the period itself. It PINS the
 * plugin's own count (storage and kv calls) so it cannot regress: 12 for 365 days
 * once the cron has built the month documents and product lines, whatever the
 * order count, against 51 before. The host adds its own session and auth queries
 * on top.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fresh migrated store per test, so each case stands alone (`-t` runs one). */
async function freshStorage(): Promise<StorageAccess> {
	return (await makeSqliteStorage(commerceStorageLayout())).storage;
}

interface Counts {
	/** Every storage call AND every kv call: on the host each `kv` call is a query too. */
	total: number;
	orderScans: number;
}

function countedContext(storage: StorageAccess): { ctx: PluginContext; counts: Counts } {
	const counts: Counts = { total: 0, orderScans: 0 };
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(storage)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					counts.total++;
					if (name === ORDERS_COLLECTION && prop === "query") counts.orderScans++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	const ctx = {
		http: {
			fetch() {
				throw new Error("no egress");
			},
		},
		// Counted with the storage: the host serves `ctx.kv` from its options table,
		// one query per call.
		kv: {
			get: async () => {
				counts.total++;
				return null;
			},
			set: async () => {
				counts.total++;
			},
			delete: async () => {
				counts.total++;
				return false;
			},
			list: async () => {
				counts.total++;
				return [];
			},
		},
		storage: wrapped,
	} as unknown as PluginContext;
	return { ctx, counts };
}

function dayAgo(days: number): string {
	return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

async function seedPaid(
	storage: StorageAccess,
	currencyCode: string,
	orderId: string,
): Promise<void> {
	const { ctx } = countedContext(storage);
	await createInProcessCommerceStores(ctx).reportingStore.recordOrderEvent({
		kind: "transition",
		orderId,
		orderCreatedAt: `${dayAgo(2)}T10:00:00.000Z`,
		currency: currencyCode,
		fromState: null,
		toState: "paid",
		orderTotalCents: 1000,
	});
}

async function measure(
	storage: StorageAccess,
	preset: "30d" | "90d" | "365d" | { from: string; to: string } = "365d",
): Promise<{ counts: Counts; res: BlockResponse }> {
	const { ctx, counts } = countedContext(storage);
	const res = (await createReportsPageHandler()(
		{
			input: typeof preset === "string" ? { preset } : preset,
			request: { method: "POST", url: "/admin", headers: {} },
		},
		ctx,
	)) as BlockResponse;
	return { counts, res };
}

describe("Reports page: storage-read budget over a 365-day range", () => {
	test("a single-currency store scans the orders once", async () => {
		const storage = await freshStorage();
		await seedPaid(storage, "USD", "q-usd-1");
		const { counts, res } = await measure(storage);
		expect(JSON.stringify(res)).not.toContain("Reports are unavailable");
		expect(counts.orderScans).toBe(1);
	}, 60_000);

	test("a multi-currency store scans the orders once too, not a second time for units", async () => {
		const storage = await freshStorage();
		await seedPaid(storage, "USD", "q-usd-1");
		await seedPaid(storage, "EUR", "q-eur-1");
		const { counts, res } = await measure(storage);
		expect(JSON.stringify(res)).not.toContain("Reports are unavailable");
		expect(counts.orderScans).toBe(1);
	}, 60_000);
});

/**
 * The plugin's queries per render on {@link largeStore}, storage and kv together,
 * once the cron's rollup refresh has caught up (`settle`). Before revenue and
 * statuses shared one rollup read per period (#572) these were 12, 21 and 67; after,
 * 10, 17 and 51. Reading a long period's whole months from month documents, and top
 * products from the rollups' product lines instead of the orders (#572), took them
 * to these. Lower a pin when a change improves it; never raise one.
 */
const PINNED_QUERIES = { "30d": 8, "90d": 10, "365d": 12 } as const;
/** 186 days (the weekly cap), settled: its day documents, both periods. */
const PINNED_WEEKLY_MAX_QUERIES = 14;

/**
 * The same renders on the same store BEFORE the refresh has run — every day's product
 * lines still to build, no month document yet: the store just upgraded across #572.
 * The figures are the same (pinned below); the reads cost what they did before.
 */
const PINNED_UNSETTLED_QUERIES = { "30d": 10, "90d": 17, "365d": 53 } as const;

/** Workers Free's queries per invocation; the host's own session and auth reads come on top. */
const WORKERS_FREE_QUERIES = 50;

/** Orders in the 365-day period itself (the full product scan pages over these). */
const PERIOD_ORDERS = 3000;

const CURRENCIES = ["EUR", "USD"] as const;

/**
 * Seeds one paid order: its document (what the top-products lines are built from)
 * and its rollup event (what the day and month documents fold).
 */
async function seedOrder(
	storage: StorageAccess,
	reporting: ReturnType<typeof createInProcessCommerceStores>["reportingStore"],
	orderId: string,
	day: string,
	currencyCode: string,
	product: number,
): Promise<void> {
	const createdAt = `${day}T10:00:00.000Z`;
	await storage[ORDERS_COLLECTION]!.put(orderId, {
		orderId,
		currency: currencyCode,
		state: "paid",
		createdAt,
		items: [
			{
				productId: `p-${product}`,
				title: `Mug ${product}`,
				quantity: 1 + product,
				unitPrice: 1000,
			},
		],
	});
	await reporting.recordOrderEvent({
		kind: "transition",
		orderId,
		orderCreatedAt: createdAt,
		currency: currencyCode,
		fromState: null,
		toState: "paid",
		orderTotalCents: 1000 * (1 + product),
	});
}

/**
 * A two-currency store with a rollup document for EVERY day of the 365-day
 * period and the year before it, in both currencies, and {@link PERIOD_ORDERS}
 * orders in the period itself, over a dozen products.
 */
async function largeStore(): Promise<StorageAccess> {
	const storage = await freshStorage();
	const { reportingStore } = createInProcessCommerceStores(countedContext(storage).ctx);
	const today = new Date().toISOString().slice(0, 10);
	const period = presetRange("365d", today);
	const previous = previousPeriod(period);
	for (let i = 0; i < PERIOD_ORDERS; i++) {
		// Day `i mod 365`, currency by lap: every day gets both currencies.
		const day = shiftDay(period.fromDay, i % 365);
		const code = CURRENCIES[Math.floor(i / 365) % 2]!;
		await seedOrder(storage, reportingStore, `big-${i}`, day, code, i % 12);
	}
	for (let d = 0; d < 365; d++) {
		const day = shiftDay(previous.fromDay, d);
		for (const code of CURRENCIES) {
			await seedOrder(storage, reportingStore, `prev-${d}-${code}`, day, code, d % 12);
		}
	}
	return storage;
}

/**
 * What the cron's rollup refresh does, run to the end: build every closed day's
 * product lines, then every past month's document (`refreshReportingRollups`).
 */
async function settle(storage: StorageAccess): Promise<void> {
	const store = new EmdashReportingStore({ storage, clock: systemClock });
	const today = new Date().toISOString().slice(0, 10);
	for (let guard = 0; guard < 100; guard++) {
		const days = await store.staleProductDays(today, 100);
		if (days.length === 0) break;
		for (const day of days) await store.rebuildDayProducts(day);
	}
	for (const month of await store.staleMonths(today.slice(0, 7), 100)) {
		expect(await store.rebuildMonth(month)).toBe(true);
	}
	expect(await store.staleMonths(today.slice(0, 7), 100)).toEqual([]);
}

describe("Reports page: the query count on a large store is pinned (#572)", () => {
	// One seed for every preset: a render only reads, so the cases cannot interfere.
	let storage: StorageAccess;
	const unsettled = new Map<string, string>();
	beforeAll(async () => {
		storage = await largeStore();
	}, 300_000);

	test.each(["30d", "90d", "365d"] as const)(
		"%s before the rollup refresh has run: the old cost, and every figure",
		async (preset) => {
			const { counts, res } = await measure(storage, preset);
			expect(JSON.stringify(res)).not.toContain("Reports are unavailable");
			unsettled.set(preset, JSON.stringify(res));
			expect(counts.total).toBe(PINNED_UNSETTLED_QUERIES[preset]);
		},
		60_000,
	);

	test.each(["30d", "90d", "365d"] as const)(
		"%s once the refresh has run: its pinned count, and the same figures",
		async (preset) => {
			await settle(storage);
			const { counts, res } = await measure(storage, preset);
			expect(JSON.stringify(res)).not.toContain("Reports are unavailable");
			// Not a figure moved: the month documents and product lines are the days and
			// the orders they were built from.
			expect(JSON.stringify(res)).toBe(unsettled.get(preset));
			expect(counts.total).toBe(PINNED_QUERIES[preset]);
		},
		120_000,
	);

	test("365 days stays well inside the Workers Free budget, and its cost does not grow with orders", async () => {
		await settle(storage);
		const { counts } = await measure(storage, "365d");
		// Comfortably under, with room for the host's own session and auth queries.
		expect(counts.total).toBeLessThanOrEqual(20);
		expect(counts.total).toBeLessThan(WORKERS_FREE_QUERIES);
		// The orders are not paged at all for a period ending in a closed day... except
		// today's, whose product lines are only ever built once it closes.
		expect(counts.orderScans).toBeLessThanOrEqual(1);
	}, 120_000);

	// The longest period still charted by week (#572 review): it reads its day documents,
	// two currencies a day, and stays inside the budget.
	test("186 days, charted by week from its day documents, stays inside the Workers Free budget", async () => {
		await settle(storage);
		const today = new Date().toISOString().slice(0, 10);
		const { counts } = await measure(storage, { from: shiftDay(today, -185), to: today });
		expect(counts.total).toBe(PINNED_WEEKLY_MAX_QUERIES);
		expect(counts.total).toBeLessThan(WORKERS_FREE_QUERIES);
	}, 120_000);
});
