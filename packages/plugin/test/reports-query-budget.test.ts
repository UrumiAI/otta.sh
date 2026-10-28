import { ORDERS_COLLECTION, type StorageAccess } from "@urumi.ai/otta-store-emdash";
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
 * plugin's own count (storage and kv calls) so it cannot regress. It is not a
 * proof of the budget: 365 days still costs 51, and the host adds its own
 * session and auth queries on top.
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
	preset: "30d" | "90d" | "365d" = "365d",
): Promise<{ counts: Counts; res: BlockResponse }> {
	const { ctx, counts } = countedContext(storage);
	const res = (await createReportsPageHandler()(
		{
			input: { preset },
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
 * The plugin's queries per render on {@link largeStore}, storage and kv together.
 * Before revenue and statuses shared one rollup read per period (#572) these were
 * 12, 21 and 67. Lower a pin when a change improves it; never raise one.
 */
const PINNED_QUERIES = { "30d": 10, "90d": 17, "365d": 51 } as const;

/** Orders in the 365-day period itself (the full product scan pages over these). */
const PERIOD_ORDERS = 3000;

const CURRENCIES = ["EUR", "USD"] as const;

/**
 * Seeds one paid order: its document (what the top-products scan reads) and its
 * rollup event (what the revenue and status reads fold).
 */
async function seedOrder(
	storage: StorageAccess,
	reporting: ReturnType<typeof createInProcessCommerceStores>["reportingStore"],
	orderId: string,
	day: string,
	currencyCode: string,
): Promise<void> {
	const createdAt = `${day}T10:00:00.000Z`;
	await storage[ORDERS_COLLECTION]!.put(orderId, {
		orderId,
		currency: currencyCode,
		state: "paid",
		createdAt,
		items: [{ productId: "p-1", title: "Mug", quantity: 1, unitPrice: 1000 }],
	});
	await reporting.recordOrderEvent({
		kind: "transition",
		orderId,
		orderCreatedAt: createdAt,
		currency: currencyCode,
		fromState: null,
		toState: "paid",
		orderTotalCents: 1000,
	});
}

/**
 * A two-currency store with a rollup document for EVERY day of the 365-day
 * period and the year before it, in both currencies, and {@link PERIOD_ORDERS}
 * orders in the period itself.
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
		await seedOrder(storage, reportingStore, `big-${i}`, day, code);
	}
	for (let d = 0; d < 365; d++) {
		const day = shiftDay(previous.fromDay, d);
		for (const code of CURRENCIES) {
			await seedOrder(storage, reportingStore, `prev-${d}-${code}`, day, code);
		}
	}
	return storage;
}

describe("Reports page: the query count on a large store is pinned (#572)", () => {
	// One seed for every preset: a render only reads, so the cases cannot interfere.
	let storage: StorageAccess;
	beforeAll(async () => {
		storage = await largeStore();
	}, 300_000);

	test.each(["30d", "90d", "365d"] as const)(
		"%s does not regress past its pinned query count",
		async (preset) => {
			const { counts, res } = await measure(storage, preset);
			expect(JSON.stringify(res)).not.toContain("Reports are unavailable");
			expect(counts.total).toBe(PINNED_QUERIES[preset]);
		},
		60_000,
	);
});
