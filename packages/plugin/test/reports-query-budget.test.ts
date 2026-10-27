import { ORDERS_COLLECTION, type StorageAccess } from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { describe, expect, test } from "vitest";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import { createReportsPageHandler } from "../src/admin/reports-page.js";
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
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fresh migrated store per test, so each case stands alone (`-t` runs one). */
async function freshStorage(): Promise<StorageAccess> {
	return (await makeSqliteStorage(commerceStorageLayout())).storage;
}

interface Counts {
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
		kv: {
			get: async () => null,
			set: async () => undefined,
			delete: async () => false,
			list: async () => [],
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

async function measure(storage: StorageAccess): Promise<{ counts: Counts; res: BlockResponse }> {
	const { ctx, counts } = countedContext(storage);
	const res = (await createReportsPageHandler()(
		{
			input: { preset: "365d" },
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
