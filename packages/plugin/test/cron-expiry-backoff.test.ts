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
import { SweepQueryCeilingError } from "../src/cron/tick-budget.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");

let storage: StorageAccess;
let warns: string[];

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	warns = [];
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warns.push(args.map(String).join(" "));
	});
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** `storage`, with the orders collection's reads of `poisoned` ids failing (with
 *  `failure()`, by default a plain error). */
function poisonedOrders(
	poisoned: ReadonlySet<string>,
	failure: () => Error = () => new Error("poisoned order"),
): StorageAccess {
	const orders = storage[ORDERS_COLLECTION];
	if (orders === undefined) throw new Error("no orders collection");
	const wrapped = new Proxy(orders, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "getVersioned" || prop === "get") {
				return async (id: string) => {
					if (poisoned.has(id)) throw failure();
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

test("the tick's query ceiling inside an order's flip ends the leg as the ceiling: no failure line, no back-off (polish P-2)", async () => {
	// The expiry leg passes `isSweepQueryCeilingError` as `stopsBatch`, so a refusal
	// raised part-way through one order's flip is the TICK's stop, not that order
	// failing: it must not be logged as one, nor put the order on back-off (where it
	// would wait five minutes for nothing).
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	await placeOrder(storage, "a", new Date(NOW.getTime() - 50 * MINUTE_MS), createdAt);
	const ctx = sweepContext(
		poisonedOrders(new Set(["order-a"]), () => new SweepQueryCeilingError(30, "expire-orders")),
	);
	const backoff = new UnitBackoff();
	const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
		cursors: memoryCursors(),
		emailSender: recordingSender([]),
		now: NOW,
		expiryBatchLimit: 2,
		expiryBackoff: backoff,
	});

	expect(summary.legs.find((entry) => entry.leg === "expire-orders")).toMatchObject({
		ok: true,
		count: 0,
		incomplete: true,
	});
	expect(
		warns.some((line) => line.includes("expire-orders stopped at the tick's query ceiling")),
	).toBe(true);
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(0);
	expect(backoff.size).toBe(0);
	expect((await adapters(storage, NOW).orderStore.getById(toOrderId("order-a")))?.state).toBe(
		"pending",
	);
}, 120_000);

test("the leg sizes the back-off's cap to the rows its one-page look can read past (polish P-3)", async () => {
	// The cap is where starvation returns (more failing orders than it, and evicted
	// ones take the bite again), so it is as large as the look's one 100-row page
	// allows beside the bite and its one extra row: 98 on Free (bite 1), 81 at the
	// Paid bite of 18. No extra query: the look was already one page.
	const tick = async (backoff: UnitBackoff, expiryBatchLimit?: number) =>
		await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
			cursors: memoryCursors(),
			emailSender: recordingSender([]),
			now: NOW,
			...(expiryBatchLimit === undefined ? {} : { expiryBatchLimit }),
			expiryBackoff: backoff,
		});
	const free = new UnitBackoff();
	await tick(free, 1);
	expect(free.maxEntries).toBe(100 - (1 + 1));
	const paid = new UnitBackoff();
	await tick(paid, 18);
	expect(paid.maxEntries).toBe(100 - (18 + 1));
	// A bite too big for the page (a test-only option) keeps the default cap.
	const huge = new UnitBackoff();
	await tick(huge, 90);
	expect(huge.maxEntries).toBe(UnitBackoff.DEFAULT_MAX_ENTRIES);
}, 120_000);
