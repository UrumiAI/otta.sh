/**
 * Review round 3, B I4: orders whose expiry flip throws EVERY time must not take
 * every tick's bite. The sweep lists the oldest lapsed orders first, so before the
 * back-off two such orders at the head of the list, with a bite of two, meant the
 * order behind them was never expired and its stock stayed held. Now a failed order
 * waits (`UnitBackoff`) and the tick's one list reads past it.
 */
import { orderId as toOrderId, UnitBackoff } from "@urumi.ai/otta-domain";
import { ORDERS_COLLECTION, type StorageAccess } from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
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
import { SWEEP_TICK_BUDGET_MS } from "../src/cron/index.js";

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

function legOf(summary: CommerceSweepSummary) {
	return summary.legs.find((entry) => entry.leg === "expire-orders");
}

function expired(summary: CommerceSweepSummary): number | undefined {
	return legOf(summary)?.count;
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
	// #447: every order the leg tried threw, so the LEG failed — the row and line
	// its alerting watches — instead of reading as a healthy tick with nothing done.
	expect(legOf(first)).toMatchObject({ ok: false, count: 0 });
	expect(legOf(first)?.error).toMatch(/every order the leg tried failed to expire/);
	expect(error.mock.calls.some((c) => /cron sweep expire-orders FAILED/.test(String(c[0])))).toBe(
		true,
	);

	// The failed orders back off, so the next tick reaches the one behind them, and
	// a tick that made progress is healthy again.
	const second = await tick(new Date(NOW.getTime() + MINUTE_MS));
	expect(expired(second)).toBe(1);
	expect(legOf(second)).toMatchObject({ ok: true });
	const s = adapters(storage, NOW);
	expect((await s.orderStore.getById(toOrderId("order-c")))?.state).toBe("expired");
	expect((await s.orderStore.getById(toOrderId("order-a")))?.state).toBe("pending");
	// Not tried again while they wait: no new failure lines.
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(2);
}, 120_000);

test("a quiet store with ONE always-failing order does not fail the leg on each back-off retry (#478, from #470)", async () => {
	// The leg used to fail whenever every order it tried threw, so one poison order
	// on an otherwise idle store failed the critical leg on every retry (5 min, 10,
	// 20, ... an hour): an alert that flaps for ever on one order. One order is
	// logged and backed off; the leg fails only once two different orders are
	// failing within the back-off window.
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	await placeOrder(storage, "a", new Date(NOW.getTime() - 50 * MINUTE_MS), createdAt);
	const ctx = sweepContext(poisonedOrders(new Set(["order-a"])));
	const backoff = new UnitBackoff();
	const cursors = memoryCursors();
	const tick = (at: Date) =>
		runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: at,
			expiryBatchLimit: 1,
			expiryBackoff: backoff,
		});
	// Each tick lands just past the order's back-off, so every one retries it.
	let at = NOW.getTime();
	for (const wait of [0, 5, 10, 20]) {
		at += wait * MINUTE_MS;
		const summary = await tick(new Date(at));
		const leg = legOf(summary);
		if (leg !== undefined) expect(leg).toMatchObject({ ok: true, count: 0 });
	}
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(4);
	expect(error.mock.calls.some((c) => /cron sweep expire-orders FAILED/.test(String(c[0])))).toBe(
		false,
	);
}, 120_000);

test("an outage on the Free bite (one order a tick) still fails the leg once a second order fails (#478)", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	for (const [tag, lapsedMinutes] of [
		["a", 50],
		["b", 40],
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
			expiryBatchLimit: 1,
			expiryBackoff: backoff,
		});
	expect(legOf(await tick(NOW))).toMatchObject({ ok: true, count: 0 });
	const second = await tick(new Date(NOW.getTime() + MINUTE_MS));
	expect(legOf(second)).toMatchObject({ ok: false, count: 0 });
	expect(legOf(second)?.error).toMatch(/every order the leg tried failed to expire/);
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(2);
}, 120_000);

test("an outage still fails the leg when the in-memory back-off is lost every tick (#478 review)", async () => {
	// The back-off is per isolate. A fresh isolate each tick loses it, and with a
	// bite of one the leg would retry the same head order for ever and never see a
	// second failing order. The failing orders are also kept in the sweep's kv
	// state, so the leg reads past them and the second failure is seen.
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	for (const [tag, lapsedMinutes] of [
		["a", 50],
		["b", 40],
		["c", 30],
	] as const) {
		await placeOrder(storage, tag, new Date(NOW.getTime() - lapsedMinutes * MINUTE_MS), createdAt);
	}
	const ctx = sweepContext(poisonedOrders(new Set(["order-a", "order-b", "order-c"])));
	const cursors = memoryCursors();
	const tick = (at: Date) =>
		runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: at,
			expiryBatchLimit: 1,
			expiryBackoff: new UnitBackoff(),
		});
	expect(legOf(await tick(NOW))).toMatchObject({ ok: true, count: 0 });
	const second = await tick(new Date(NOW.getTime() + MINUTE_MS));
	expect(legOf(second)).toMatchObject({ ok: false, count: 0 });
	expect(legOf(second)?.error).toMatch(/every order the leg tried failed to expire/);
	const tried = error.mock.calls
		.map((c) => String(c[0]))
		.filter((line) => /expiring order/.test(line));
	expect(tried).toHaveLength(2);
}, 120_000);

test("ONE always-failing order with the back-off lost every tick still never fails the leg (#478 review)", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	await placeOrder(storage, "a", new Date(NOW.getTime() - 50 * MINUTE_MS), createdAt);
	const ctx = sweepContext(poisonedOrders(new Set(["order-a"])));
	const cursors = memoryCursors();
	for (let minute = 0; minute < 40; minute++) {
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: new Date(NOW.getTime() + minute * MINUTE_MS),
			expiryBatchLimit: 1,
			expiryBackoff: new UnitBackoff(),
		});
		const leg = legOf(summary);
		if (leg !== undefined) expect(leg, `minute ${String(minute)}`).toMatchObject({ ok: true });
	}
	// Retried after 5, then 10, then 20 minutes, not every tick: the kv record
	// backs it off when the isolate's back-off is gone.
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(4);
}, 120_000);

/** The kv record of failing orders a tick left behind. */
async function expiryFailuresIn(cursors: ReturnType<typeof memoryCursors>) {
	const raw = await cursors.read("state");
	return (JSON.parse(raw ?? "{}") as { expiryFailures?: Record<string, { n: number; at: string }> })
		.expiryFailures;
}

test("a failure stamped in the future counts as now: re-stamped, and the order expires one base wait later (#478 review)", async () => {
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	await placeOrder(storage, "a", new Date(NOW.getTime() - 50 * MINUTE_MS), createdAt);
	const cursors = memoryCursors();
	await cursors.write(
		"state",
		JSON.stringify({ expiryFailures: { "order-a": { n: 1, at: "2099-01-01T00:00:00Z" } } }),
	);
	const tick = (at: Date) =>
		runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: at,
			expiryBatchLimit: 1,
			expiryBackoff: new UnitBackoff(),
		});
	const s = adapters(storage, NOW);
	await tick(NOW);
	expect((await s.orderStore.getById(toOrderId("order-a")))?.state).toBe("pending");
	expect(await expiryFailuresIn(cursors)).toEqual({
		"order-a": { n: 1, at: NOW.toISOString() },
	});
	await tick(new Date(NOW.getTime() + UnitBackoff.DEFAULT_BASE_MS));
	expect((await s.orderStore.getById(toOrderId("order-a")))?.state).toBe("expired");
	expect(await expiryFailuresIn(cursors)).toEqual({});
}, 120_000);

const recent = (minutesAgo: number) =>
	new Date(NOW.getTime() - minutesAgo * MINUTE_MS).toISOString();

test.each([
	["a string", "nope", {}],
	["an array", [{ n: 1, at: recent(1) }], {}],
	["null", null, {}],
	["an entry that is null", { "order-a": null }, {}],
	["a string n", { "order-a": { n: "1", at: recent(1) } }, {}],
	["a zero n", { "order-a": { n: 0, at: recent(1) } }, {}],
	["a fractional n", { "order-a": { n: 1.5, at: recent(1) } }, {}],
	["a bad at", { "order-a": { n: 1, at: "yesterday-ish" } }, {}],
	["a missing at", { "order-a": { n: 1 } }, {}],
	["an empty id", { "": { n: 1, at: recent(1) } }, {}],
	["a too-long id", { ["x".repeat(129)]: { n: 1, at: recent(1) } }, {}],
	["an entry past the window", { "order-z": { n: 3, at: recent(90) } }, {}],
	[
		"one good entry among bad ones",
		{ "order-z": { n: 2, at: recent(1) }, "order-a": { n: -1, at: recent(1) } },
		{ "order-z": { n: 2, at: recent(1) } },
	],
] as const)(
	"a malformed kv record of failing orders (%s) is read safely: the order is not held back (#478 review)",
	async (_why, expiryFailures, kept) => {
		const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
		await placeOrder(storage, "a", new Date(NOW.getTime() - 50 * MINUTE_MS), createdAt);
		const cursors = memoryCursors();
		await cursors.write("state", JSON.stringify({ expiryFailures }));
		const summary = await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: NOW,
			expiryBatchLimit: 1,
			expiryBackoff: new UnitBackoff(),
		});
		expect(legOf(summary)).toMatchObject({ ok: true, count: 1 });
		expect((await adapters(storage, NOW).orderStore.getById(toOrderId("order-a")))?.state).toBe(
			"expired",
		);
		expect(await expiryFailuresIn(cursors)).toEqual(kept);
	},
	120_000,
);

test("a kv record of more than 8 failing orders keeps the 8 newest (#478 review)", async () => {
	const many = Object.fromEntries(
		Array.from({ length: 11 }, (_unused, i) => [`gone-${String(i)}`, { n: 1, at: recent(i + 1) }]),
	);
	const cursors = memoryCursors();
	await cursors.write("state", JSON.stringify({ expiryFailures: many }));
	await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
		cursors,
		emailSender: recordingSender([]),
		now: NOW,
		expiryBatchLimit: 1,
		expiryBackoff: new UnitBackoff(),
	});
	expect(Object.keys((await expiryFailuresIn(cursors)) ?? {}).toSorted()).toEqual(
		Array.from({ length: 8 }, (_unused, i) => `gone-${String(i)}`).toSorted(),
	);
}, 120_000);

test("one failing order among good ones: the leg made progress, so it stays ok (#447)", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	for (const [tag, lapsedMinutes] of [
		["a", 50],
		["b", 40],
	] as const) {
		await placeOrder(storage, tag, new Date(NOW.getTime() - lapsedMinutes * MINUTE_MS), createdAt);
	}
	const summary = await runCommerceSweeps(
		sweepContext(poisonedOrders(new Set(["order-a"]))),
		SWEEP_TASK_NAME,
		{
			cursors: memoryCursors(),
			emailSender: recordingSender([]),
			now: NOW,
			expiryBatchLimit: 2,
			expiryBackoff: new UnitBackoff(),
		},
	);
	expect(legOf(summary)).toMatchObject({ ok: true, count: 1 });
	expect(error.mock.calls.filter((c) => /expiring order/.test(String(c[0])))).toHaveLength(1);
}, 120_000);

test("a tick whose FIRST pass expired an order and whose second pass only met failing ones is not a failed leg (#447 review)", async () => {
	// The leg runs twice on a tick its share stopped (THE SECOND PASS). `allFailed`
	// speaks for ONE call, so the leg fails only when nothing expired all tick.
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS);
	for (const [tag, lapsedMinutes] of [
		["a", 50],
		["b", 40],
		["c", 30],
	] as const) {
		await placeOrder(storage, tag, new Date(NOW.getTime() - lapsedMinutes * MINUTE_MS), createdAt);
	}
	// Time drives the split: the good order's unit takes 30% of the tick, so the
	// leg's half share stops after it, and the second pass (on what the tick has
	// left) reaches only the failing orders behind it.
	let ms = 0;
	let slowed = false;
	let pass = 1;
	const triedIn: Record<string, number> = {};
	const base = poisonedOrders(new Set(["order-b", "order-c"]));
	const orders = base[ORDERS_COLLECTION];
	if (orders === undefined) throw new Error("no orders collection");
	const timed = new Proxy(orders, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "getVersioned") {
				return async (id: string) => {
					triedIn[id] ??= pass;
					if (id === "order-a" && !slowed) {
						slowed = true;
						ms += 0.3 * SWEEP_TICK_BUDGET_MS;
						pass = 2;
					}
					return (value as (id: string) => Promise<unknown>).call(target, id);
				};
			}
			return (value as (...args: unknown[]) => unknown).bind(target);
		},
	});
	const summary = await runCommerceSweeps(
		sweepContext({ ...base, [ORDERS_COLLECTION]: timed }),
		SWEEP_TASK_NAME,
		{
			cursors: memoryCursors(),
			emailSender: recordingSender([]),
			now: NOW,
			queryBudget: 100_000,
			tickClock: () => ms,
			expiryBatchLimit: 3,
			expiryBackoff: new UnitBackoff(),
		},
	);
	// Both passes ran: the good order expired in the first, and only failing
	// orders were tried after it.
	expect((await adapters(storage, NOW).orderStore.getById(toOrderId("order-a")))?.state).toBe(
		"expired",
	);
	expect(triedIn["order-a"]).toBe(1);
	expect(triedIn["order-b"]).toBe(2);
	expect(
		error.mock.calls.filter((c) => /expiring order/.test(String(c[0]))).length,
	).toBeGreaterThan(0);
	expect(legOf(summary)).toMatchObject({ ok: true, count: 1 });
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
