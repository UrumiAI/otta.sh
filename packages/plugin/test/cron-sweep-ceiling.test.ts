/**
 * The tick's QUERY CEILING and its per-leg accounting (QA2 M2).
 *
 * WHY. On the Workers Free preset (30 calls a tick) QA logged one tick at 334 of
 * 30 queries and another at 44 — over Workers Free's 50 per invocation, where the
 * real Worker would have failed — and nothing in the log said which leg spent them.
 * The culprit was `reporting-heal`: a closed day's FIRST heal absorbs every live
 * rollup claim of that day, two calls each, inside ONE `reconcile` call that the
 * tick could not stop part-way. `prune-challenges` had the same shape (a delete per
 * row, no check between them).
 *
 * So this suite pins: every leg reports the calls it made; the tick's total never
 * passes its budget, whatever a leg's unit turns out to cost; a heal too big for one
 * tick makes progress tick by tick instead of overrunning; and an idle tick is quiet
 * and cheap (no "0 (more next tick)", no expiry deferred for want of room it never
 * needed).
 */
import { cents, currency, idempotencyKey } from "@otta-sh/domain";
import {
	collectionOf,
	EmdashCouponStore,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepLeg,
} from "../src/cron/index.js";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import {
	adapters,
	DAY_MS,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	placeOrder,
	recordingSender,
	sweepContext,
	type CallCounter,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";
import { orderId as toOrderId } from "@otta-sh/domain";

const FREE = 30;
const NOW = new Date("2026-09-20T12:00:00.000Z");

let storage: StorageAccess;
let logs: string[];

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	logs = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

function options(over: Partial<CommerceSweepOptions> = {}): CommerceSweepOptions {
	return { cursors: memoryCursors(), emailSender: recordingSender([]), now: NOW, ...over };
}

function leg(summary: CommerceSweepSummary, name: SweepLeg) {
	const found = summary.legs.find((entry) => entry.leg === name);
	if (found === undefined) throw new Error(`no ${name} leg`);
	return found;
}

/** `n` orders created on the CLOSED day, each paid — two live rollup claims each
 *  (its creation and its pending → paid move), none of them absorbed yet. */
async function busyClosedDay(n: number): Promise<void> {
	const createdAt = new Date(NOW.getTime() - DAY_MS);
	for (let i = 0; i < n; i++) {
		const placed = await placeOrder(
			storage,
			`closed-${String(i)}`,
			new Date(createdAt.getTime() + HOUR_MS),
			createdAt,
		);
		const s = adapters(storage, createdAt);
		await s.orderStore.markPaid(toOrderId(placed.id));
		// Settled as checkout settles it: the stock committed, nothing left owing.
		await s.orderStore.completeHoldAdoption(toOrderId(placed.id));
		await s.orderStore.completeHoldCommit(toOrderId(placed.id));
	}
}

describe("no tick passes its query budget", () => {
	test("a closed day's first rollup heal (QA's 334-query tick) is spread over ticks, never over the budget", async () => {
		await busyClosedDay(40);
		const cursors = memoryCursors();
		// Everything else those orders left (their confirmation emails, their sku
		// pointers) is drained first on the Paid preset with the rollup heal not due,
		// and then the other scans are marked done — so what follows is the heal alone.
		const otherScansDone = (): string =>
			JSON.stringify({
				lastRun: Object.fromEntries(
					["prune-challenges", "sku-transfers", "order-sku-index", "coupon-orphans"].map((name) => [
						name,
						NOW.toISOString(),
					]),
				),
			});
		for (let i = 0; i < 3; i++) {
			await cursors.write(
				"state",
				JSON.stringify({ lastRun: { "reporting-heal": NOW.toISOString() } }),
			);
			await runCommerceSweeps(
				sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: 600 }),
				SWEEP_TASK_NAME,
				options({ cursors }),
			);
		}
		await cursors.write("state", otherScansDone());
		const counter: CallCounter = { calls: 0 };
		const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: FREE });
		let healed = false;
		let ticks = 0;
		for (let minute = 0; minute < 25 && !healed; minute++) {
			ticks++;
			counter.calls = 0;
			const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				...options({ cursors }),
				now: new Date(NOW.getTime() + minute * MINUTE_MS),
			});
			expect(counter.calls, `minute ${String(minute)}`).toBeLessThanOrEqual(FREE);
			expect(summary.budget.queriesUsed).toBe(counter.calls);
			const heal = leg(summary, "reporting-heal");
			expect(heal.ok, heal.error).toBe(true);
			healed = heal.notDue !== true && heal.deferred !== true && heal.incomplete !== true;
		}
		// 80 unabsorbed claims at two calls each: about five absorbed a tick on Free.
		expect(healed, `the heal finished inside 25 Free ticks (took ${String(ticks)})`).toBe(true);
	}, 120_000);

	test("a pile of expired sign-in challenges is pruned a bite per tick, never past the budget", async () => {
		const challenges = collectionOf<Record<string, unknown>>(storage, "login_challenges");
		const expired = new Date(NOW.getTime() - HOUR_MS).toISOString();
		for (let i = 0; i < 120; i++) {
			await challenges.put(`ch-${String(i)}`, {
				challengeId: `ch-${String(i)}`,
				email: `a${String(i)}@example.test`,
				emailLower: `a${String(i)}@example.test`,
				tokenHash: "x",
				createdAt: expired,
				expiresAt: expired,
				consumedAt: null,
				consumed: "no",
			});
		}
		const counter: CallCounter = { calls: 0 };
		const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: FREE });
		const cursors = memoryCursors();
		let pruned = 0;
		for (let minute = 0; minute < 60 && pruned < 120; minute++) {
			counter.calls = 0;
			const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				...options({ cursors }),
				// Fifteen minutes apart, so the pruning cadence is due every time.
				now: new Date(NOW.getTime() + minute * 15 * MINUTE_MS),
			});
			expect(counter.calls, `tick ${String(minute)}`).toBeLessThanOrEqual(FREE);
			pruned += leg(summary, "prune-challenges").count;
		}
		expect(pruned).toBe(120);
	}, 120_000);
});

describe("per-leg query accounting", () => {
	test("every leg reports the calls it made, and the legs plus the tick's own reads add up to the total", async () => {
		await busyClosedDay(3);
		const counter: CallCounter = { calls: 0 };
		const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: 600 });
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options());

		let sum = summary.budget.overheadQueries;
		for (const entry of summary.legs) {
			expect(entry.queries, entry.leg).toBeGreaterThanOrEqual(0);
			sum += entry.queries;
		}
		expect(sum).toBe(summary.budget.queriesUsed);
		expect(summary.budget.queriesUsed).toBe(counter.calls);
		// The paid orders owed their stock commit: that leg did real work and says so.
		expect(leg(summary, "hold-intents").queries).toBeGreaterThan(0);
	}, 120_000);

	test("a tick that did work logs one line naming what each leg spent", async () => {
		await busyClosedDay(2);
		const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: FREE });
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options());
		const line = logs.find((entry) => entry.startsWith("[otta] cron sweep used "));
		expect(line, logs.join("\n")).toBeDefined();
		expect(line).toContain(`${String(summary.budget.queriesUsed)} of ${String(FREE)} queries`);
		for (const entry of summary.legs) {
			if (entry.queries > 0) expect(line).toContain(`${entry.leg} ${String(entry.queries)}`);
		}
	}, 120_000);
});

describe("an idle tick", () => {
	test("is cheap and quiet: nothing deferred, nothing 'more next tick', no state write", async () => {
		const counter: CallCounter = { calls: 0 };
		const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: FREE });
		const cursors = memoryCursors();
		// The first ticks run the slow-cadence scans (the rollup heal walks its
		// back-fill days a bite at a time); the idle minute is the one after them.
		let minute = 0;
		for (; minute < 10; minute++) {
			const warmup = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				...options({ cursors }),
				now: new Date(NOW.getTime() + minute * MINUTE_MS),
			});
			if (warmup.legs.every((entry) => entry.incomplete !== true && entry.deferred !== true)) break;
		}
		logs.length = 0;
		counter.calls = 0;
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			...options({ cursors }),
			now: new Date(NOW.getTime() + (minute + 1) * MINUTE_MS),
		});
		for (const entry of summary.legs) {
			expect(entry.deferred, entry.leg).toBeUndefined();
			expect(entry.incomplete, entry.leg).toBeUndefined();
			expect(entry.count, entry.leg).toBe(0);
		}
		expect(logs, logs.join("\n")).toEqual([]);
		// One read each: the setting, the cadence state, and each every-minute leg's
		// "anything due?" check — and no write.
		expect(summary.budget.queriesUsed).toBeLessThanOrEqual(8);
		expect(counter.calls).toBe(summary.budget.queriesUsed);
	}, 120_000);

	test("an empty outbox is not reported as 'more next tick', and never defers the expiry behind it", async () => {
		const placed = await placeOrder(
			storage,
			"idle-expiry",
			new Date(NOW.getTime() - 30 * MINUTE_MS),
			new Date(NOW.getTime() - HOUR_MS),
		);
		const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: FREE });
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options());
		expect(leg(summary, "expire-orders")).toMatchObject({ ok: true, count: 1 });
		expect(leg(summary, "expire-orders").deferred).toBeUndefined();
		expect((await adapters(storage).orderStore.getById(toOrderId(placed.id)))?.state).toBe(
			"expired",
		);
		expect(logs.some((entry) => entry.includes("order-emails 0"))).toBe(false);
	}, 120_000);
});

describe("coupon-orphans under an expiry backlog", () => {
	test("waits at an order the expiry has not reached, never deferring itself whole, and frees the coupon once it has", async () => {
		// An order whose hold lapsed, still `pending` because the expiry has not reached
		// it, holding a coupon redemption old enough to judge. Its `appliedCouponCode`
		// is not stamped, so the expiry itself skips the coupon release — the sweeper's
		// `expired` arm is what frees it (the backstop the expiry's skip relies on).
		const placed = await placeOrder(
			storage,
			"coupon-wait",
			new Date(NOW.getTime() - 30 * MINUTE_MS),
			new Date(NOW.getTime() - 2 * HOUR_MS),
		);
		const coupons = new EmdashCouponStore({
			storage,
			idGen: uuidIdGen,
			clock: adapters(storage).clock,
		});
		await coupons.create({
			id: "coupon-wait",
			code: "WAIT10",
			type: "percentage",
			amountCents: null,
			rateBps: 1000,
			capCents: null,
			currency: currency("USD"),
			minSubtotalCents: cents(0),
			startsAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
			expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
			maxUses: 10,
			maxUsesPerCustomer: null,
		});
		const redeemed = await coupons.redeem({
			couponId: "coupon-wait",
			orderId: toOrderId(placed.id),
			idempotencyKey: idempotencyKey("redeem-wait"),
			createdAt: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
		});
		expect(redeemed.ok).toBe(true);
		const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: 600 });
		const cursors = memoryCursors();

		// A tick whose expiry cannot run (a malformed bite fails that leg loudly): the
		// coupon sweeper still runs — it no longer defers itself whole — and stops at
		// the pending order instead of judging it.
		const blocked = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			...options({ cursors }),
			expiryBatchLimit: 0,
		});
		expect(leg(blocked, "expire-orders").ok).toBe(false);
		expect(leg(blocked, "coupon-orphans")).toMatchObject({ ok: true, count: 0, incomplete: true });
		expect(leg(blocked, "coupon-orphans").deferred).toBeUndefined();
		expect((await coupons.findById("coupon-wait"))?.usesCount).toBe(1);

		// The expiry catches up; the sweeper, resuming before that order, frees it.
		const caught = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			...options({ cursors }),
			now: new Date(NOW.getTime() + MINUTE_MS),
		});
		expect(leg(caught, "expire-orders")).toMatchObject({ ok: true, count: 1 });
		expect(leg(caught, "coupon-orphans")).toMatchObject({ ok: true, count: 1 });
		expect((await coupons.findById("coupon-wait"))?.usesCount).toBe(0);
	}, 120_000);
});
