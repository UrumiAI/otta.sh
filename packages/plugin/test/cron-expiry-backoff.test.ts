/**
 * Review round 3, B I4: orders whose expiry flip throws EVERY time must not take
 * every tick's bite. The sweep lists the oldest lapsed orders first, so before the
 * back-off two such orders at the head of the list, with a bite of two, meant the
 * order behind them was never expired and its stock stayed held. Now a failed order
 * waits (`UnitBackoff`) and the tick's one list reads past it.
 */
import { orderId as toOrderId, UnitBackoff } from "@otta-sh/domain";
import { ORDERS_COLLECTION, type StorageAccess } from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepSummary,
} from "../src/cron/index.js";
import {
	adapters,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	placeOrder,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");

let storage: StorageAccess;

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** `storage`, with the orders collection's reads of `poisoned` ids failing. */
function poisonedOrders(poisoned: ReadonlySet<string>): StorageAccess {
	const orders = storage[ORDERS_COLLECTION];
	if (orders === undefined) throw new Error("no orders collection");
	const wrapped = new Proxy(orders, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "getVersioned" || prop === "get") {
				return async (id: string) => {
					if (poisoned.has(id)) throw new Error("poisoned order");
					return (value as (id: string) => Promise<unknown>).call(target, id);
				};
			}
			return (value as (...args: unknown[]) => unknown).bind(target);
		},
	});
	return { ...storage, [ORDERS_COLLECTION]: wrapped };
}

function expired(summary: CommerceSweepSummary): number | undefined {
	return summary.legs.find((entry) => entry.leg === "expire-orders")?.count;
}

test("two orders whose flip always fails cannot hold the bite: the order behind them expires next tick", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	for (const [tag, lapsedMinutes] of [
		["a", 50],
		["b", 40],
		["c", 30],
	] as const) {
		await placeOrder(storage, tag, new Date(NOW.getTime() - lapsedMinutes * MINUTE_MS), createdAt);
	}
	const ctx = sweepContext(poisonedOrders(new Set(["order-a", "order-b"])));
	const backoff = new UnitBackoff();
	const cursors = memoryCursors();
	const tick = (at: Date) =>
		runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: at,
			expiryBatchLimit: 2,
			expiryBackoff: backoff,
		});

	const first = await tick(NOW);
	expect(expired(first) ?? 0).toBe(0);
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(2);

	const second = await tick(new Date(NOW.getTime() + MINUTE_MS));
	expect(expired(second)).toBe(1);
	const s = adapters(storage, NOW);
	expect((await s.orderStore.getById(toOrderId("order-c")))?.state).toBe("expired");
	expect((await s.orderStore.getById(toOrderId("order-a")))?.state).toBe("pending");
	// Not tried again while they wait: no new failure lines.
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(2);
}, 120_000);
