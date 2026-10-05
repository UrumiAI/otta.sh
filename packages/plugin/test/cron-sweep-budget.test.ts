/**
 * The cron tick's CADENCE and TIME BUDGET, over a real document store.
 *
 * WHY THIS SUITE EXISTS. End-to-end QA found two compounding defects in the
 * commerce sweep. The task was due every fifteen minutes while the site's Worker
 * cron fires every minute, so a fifteen-minute hold actually lasted up to thirty
 * and a queued email waited up to fifteen. And the nine legs ran back to back
 * inside ONE host hook that the host abandons after 5000 ms: the dev log showed
 * `expire-holds 18`, `expire-orders 14`, then `Hook timeout after 5000ms` — so the
 * outbox and the five completers after it never ran at all, on every tick.
 *
 * So this suite pins: the task is due every minute; the hook's timeout is
 * declared rather than inherited; the tick spends at most its budget, which sits
 * below that timeout; the customer-visible legs run first, taking turns to lead; a leg the budget did
 * not reach is reported `deferred` (not failed) and runs on the next tick; the
 * expiry legs take bounded bites so a backlog drains over several ticks; and the
 * heavy scan legs keep the fifteen-minute cadence that bounds their read cost.
 *
 * TIME IS SIMULATED, NOT SLEPT. The tick measures its budget with an injected
 * millisecond clock, and the "slow" storage below advances that clock on every
 * collection call — the same thing a slow D1 round trip does to the real one —
 * so a case can stage a five-second backlog in a few milliseconds of wall time.
 *
 * In-process rather than inside workerd because every case here needs to control
 * the tick's own clock and bookkeeping, which the isolate's boot-scoped context
 * makes impossible from outside; `cron-sweeps.sandbox.test.ts` drives the same
 * `runCommerceSweeps` through the real isolate.
 */
import {
	cents,
	currency,
	EmailSendTimeoutError,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	type EmailSender,
	type SendEmailInput,
} from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashCartStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	ORDERS_COLLECTION,
	systemClock,
	uuidIdGen,
	type OrderDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { PRODUCT_COMMERCE_COLLECTION } from "@otta-sh/store-emdash";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createCronHandler,
	ensureSweepTaskScheduled,
	MAINTENANCE_LEG_INTERVAL_MS,
	MAINTENANCE_LEGS,
	resetSweepBootstrapForTest,
	runCommerceSweeps,
	SWEEP_EMAIL_SEND_TIMEOUT_MS,
	SWEEP_HOOK_TIMEOUT_MS,
	SWEEP_LEGS,
	SWEEP_SCHEDULE,
	SWEEP_TASK_NAME,
	SWEEP_TICK_BUDGET_MS,
	SWEEP_TICK_QUERY_BUDGET,
	SWEEP_TICK_RESERVE_MS,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepCursorStore,
	type SweepLeg,
	type SweepLegOutcome,
} from "../src/cron/index.js";
import {
	BACKGROUND_WORK_KEY,
	BACKGROUND_WORK_PRESETS,
	DEFAULT_BACKGROUND_WORK,
	MIN_BACKGROUND_WORK,
} from "../src/cron/background-work-setting.js";
import { CRITICAL_LEGS, minimumQueryBudget } from "../src/cron/sweeps.js";
import plugin from "../src/plugin.js";
import type { PluginContext } from "../src/types.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

let storage: StorageAccess;

beforeAll(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
}, 120_000);

describe("the sweep's schedule and timeout are pinned", () => {
	test("the task is due every minute, matching the site's Worker cron", () => {
		// A fifteen-minute task under a one-minute trigger is what stretched a
		// fifteen-minute hold to thirty. Holds and the outbox need the trigger's
		// own resolution.
		expect(SWEEP_SCHEDULE).toBe("* * * * *");
	});

	test("the cron hook DECLARES its timeout, and the tick budget sits below it with headroom", () => {
		// Inheriting the host default made the bound invisible; declaring it is what
		// lets the budget be derived from — and tested against — the real limit.
		expect(plugin.hooks?.cron?.timeout).toBe(SWEEP_HOOK_TIMEOUT_MS);
		// The headroom between the budget and the hook's timeout must hold one whole
		// email send plus the trailing reserve: a send is the one unit whose
		// duration is set by someone else, and it is capped at exactly this.
		expect(SWEEP_HOOK_TIMEOUT_MS - SWEEP_TICK_BUDGET_MS).toBeGreaterThanOrEqual(
			SWEEP_EMAIL_SEND_TIMEOUT_MS + SWEEP_TICK_RESERVE_MS,
		);
	});

	test("the per-tick query budget fits Workers Free's 50 D1 queries per invocation", () => {
		// Cloudflare: 50 D1 queries (and 50 subrequests) per Worker invocation on
		// Free, 1000 on Paid. The host's executor, its scheduled-publishing pass and
		// the task bookkeeping share that invocation, so the sweep keeps 20 back.
		expect(SWEEP_TICK_QUERY_BUDGET).toBeLessThanOrEqual(30);
	});

	test("the critical legs come first in the summary, expiry before the coupon sweeper, and only housekeeping is on the slow cadence", () => {
		expect(SWEEP_LEGS.slice(0, 3)).toEqual([...CRITICAL_LEGS]);
		expect(SWEEP_LEGS.indexOf("expire-orders")).toBeLessThan(SWEEP_LEGS.indexOf("coupon-orphans"));
		// The four scans, and (QA2 M2) the sign-in challenge prune — housekeeping a
		// customer never waits on.
		expect([...MAINTENANCE_LEGS].toSorted()).toEqual(
			[
				"coupon-orphans",
				"order-sku-index",
				"prune-challenges",
				"reporting-heal",
				"sku-transfers",
			].toSorted(),
		);
		expect(MAINTENANCE_LEG_INTERVAL_MS).toBe(15 * MINUTE_MS);
	});
});

describe("the tick's time budget", () => {
	test("slow early work never starves the rest: the tick stops inside its budget and defers, and the next tick resumes", async () => {
		const suffix = `slow-${crypto.randomUUID()}`;
		// The QA shape: an expiry backlog whose per-call latency adds up to more than
		// the hook's whole timeout.
		const holds = await seedExpiredHolds(suffix, 30);
		const clock = new SimulatedClock();
		const sent: SendEmailInput[] = [];
		const options = baseOptions({
			tickClock: clock.read,
			emailSender: recordingSender(sent),
		});
		const ctx = context(slowStorage(storage, clock, 40));

		const first = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options);
		// Within the BUDGET itself, not merely the hook: the check before each unit
		// allows for the slowest unit seen so far plus the trailing reserve.
		expect(clock.elapsed()).toBeLessThanOrEqual(SWEEP_TICK_BUDGET_MS);
		// The outbox ran (first, and not starved by the backlog behind it).
		expect(outcome(first, "order-emails").deferred).toBeUndefined();
		// The backlog took a bite, not the whole tick's life.
		const holdsLeg = outcome(first, "expire-holds");
		expect(holdsLeg.ok).toBe(true);
		expect(holdsLeg.incomplete).toBe(true);
		expect(holdsLeg.count).toBeGreaterThan(0);
		expect(holdsLeg.count).toBeLessThan(holds.length);
		// Whatever the budget did not reach is DEFERRED, which is not a failure.
		for (const entry of first.legs)
			expect({ leg: entry.leg, ok: entry.ok }).toEqual({ leg: entry.leg, ok: true });
		expect(first.legs.map((entry) => entry.leg)).toEqual([...SWEEP_LEGS]);

		// The next ticks pick up where this one stopped, until the backlog is gone.
		let reclaimed = holdsLeg.count;
		for (let i = 0; i < 60 && reclaimed < holds.length; i++) {
			clock.reset();
			const next = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options);
			expect(clock.elapsed()).toBeLessThanOrEqual(SWEEP_TICK_BUDGET_MS);
			reclaimed += outcome(next, "expire-holds").count;
		}
		expect(reclaimed).toBe(holds.length);
		const s = stores();
		expect(await s.inventory.getOnHand(toSku(`BUDGET-${suffix}`))).toBe(holds.length);
	}, 120_000);

	test("a slow outbox is cut off BEFORE a claim, does not starve the expiries, and the unsent mail goes out on later ticks", async () => {
		const suffix = `mail-${crypto.randomUUID()}`;
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await placePaidOrder(`${suffix}-${String(n)}`);
		const clock = new SimulatedClock();
		const sent: SendEmailInput[] = [];
		// Each send costs 1.5 s: the outbox's share of the tick holds a few (and the
		// second pass a few more of what the other legs left), and the rest wait for
		// the next tick rather than overrunning this one.
		const options = baseOptions({
			tickClock: clock.read,
			emailSender: recordingSender(sent, () => clock.advance(1500)),
		});

		const first = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
		const firstSent = sent.filter((input) => String(input.data.orderId).includes(suffix));
		expect(firstSent.length).toBeLessThan(8);
		expect(clock.elapsed()).toBeLessThanOrEqual(SWEEP_TICK_BUDGET_MS);
		expect(outcome(first, "order-emails").incomplete).toBe(true);
		// A slow outbox takes its share, not the tick: the expiries still ran.
		expect(outcome(first, "expire-holds").deferred).toBeUndefined();
		expect(outcome(first, "expire-orders").deferred).toBeUndefined();

		for (let i = 0; i < 6; i++) {
			clock.reset();
			await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
		}
		const allSent = sent.filter((input) => String(input.data.orderId).includes(suffix));
		expect(new Set(allSent.map((input) => input.data.orderId)).size).toBe(8);
	}, 120_000);

	test("a provider that hangs for 30 s is cut off by the send timeout, inside the budget", async () => {
		const suffix = `hang-${crypto.randomUUID()}`;
		await placePaidOrder(`${suffix}-1`);
		await placePaidOrder(`${suffix}-2`);
		const clock = new SimulatedClock();
		const timeouts: number[] = [];
		// The real sender aborts its request at `requestTimeoutMs`; this one models a
		// provider that would answer after 30 s, honouring the abort exactly.
		// No injected `emailSender`: the leg builds its sender from the factory, the
		// path production takes, and hands it the per-send timeout.
		const options: CommerceSweepOptions = {
			cursors: memoryCursors(),
			queryBudget: 100_000,
			tickClock: clock.read,
			emailSenderFactory: async (requestTimeoutMs) => ({
				async send() {
					const timeout = requestTimeoutMs();
					timeouts.push(timeout);
					clock.advance(Math.min(30_000, timeout));
					throw new EmailSendTimeoutError(timeout);
				},
			}),
		};

		const summary = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
		expect(timeouts.length).toBeGreaterThan(0);
		for (const timeout of timeouts) {
			expect(timeout).toBeGreaterThan(0);
			expect(timeout).toBeLessThanOrEqual(SWEEP_EMAIL_SEND_TIMEOUT_MS);
		}
		expect(clock.elapsed()).toBeLessThanOrEqual(SWEEP_TICK_BUDGET_MS);
		// Not starved by the hang either.
		expect(outcome(summary, "expire-holds").deferred).toBeUndefined();
		// And the timed-out row was handed back UNCOUNTED, not spent.
		for (const entry of await outboxOf(`${suffix}-1`)) expect(entry.attempts).toBe(0);
	}, 120_000);

	test("a slow-but-working provider (2 s a send) DELIVERS — the send cap leaves room for it", async () => {
		const suffix = `twosec-${crypto.randomUUID()}`;
		await placePaidOrder(`${suffix}-1`);
		const clock = new SimulatedClock();
		const options: CommerceSweepOptions = {
			cursors: memoryCursors(),
			queryBudget: 100_000,
			tickClock: clock.read,
			emailSenderFactory: async (requestTimeoutMs) => ({
				async send() {
					const timeout = requestTimeoutMs();
					clock.advance(Math.min(2000, timeout));
					if (timeout < 2000) throw new EmailSendTimeoutError(timeout);
				},
			}),
		};
		for (let tick = 0; tick < 3; tick++) {
			clock.reset();
			await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
			if ((await outboxOf(`${suffix}-1`)).every((entry) => entry.status === "sent")) break;
		}
		const entries = await outboxOf(`${suffix}-1`);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) expect(entry.status).toBe("sent");
	}, 120_000);

	test("a 2 s provider whose sends the TICK cuts short (outbox not leading, little time left) never gains timeouts", async () => {
		const suffix = `cutshort-${crypto.randomUUID()}`;
		await placePaidOrder(`${suffix}-1`);
		const clock = new SimulatedClock();
		const given: number[] = [];
		const options: CommerceSweepOptions = {
			cursors: memoryCursors(),
			queryBudget: 100_000,
			// A tick with little time: the outbox's share leaves < 2 s per send, so
			// every send is cut short by US, never given its full cap.
			budgetMs: 2500,
			tickClock: clock.read,
			emailSenderFactory: async (requestTimeoutMs) => ({
				async send() {
					const timeout = requestTimeoutMs();
					given.push(timeout);
					clock.advance(Math.min(2000, timeout));
					if (timeout < 2000) throw new EmailSendTimeoutError(timeout);
				},
			}),
		};
		const start = Date.now();
		for (let tick = 0; tick < 5; tick++) {
			clock.reset();
			await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, {
				...options,
				// A minute in which the outbox does not lead.
				now: new Date(start + (3 * tick + 1) * MINUTE_MS),
			});
		}
		expect(given.length).toBeGreaterThan(0);
		for (const timeout of given) expect(timeout).toBeLessThan(SWEEP_EMAIL_SEND_TIMEOUT_MS);
		for (const entry of await outboxOf(`${suffix}-1`)) {
			expect(entry.timeouts ?? 0).toBe(0);
			expect(entry.attempts).toBe(0);
			expect(entry.status).toBe("pending");
		}
		// Drain it with a full tick so later cases start clean.
		await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, baseOptions());
	}, 120_000);

	test("a row that ALWAYS times out does not keep a second due row from going out", async () => {
		const suffix = `stuck-${crypto.randomUUID()}`;
		await placePaidOrder(`${suffix}-a`); // first in line, and it always times out
		await placePaidOrder(`${suffix}-b`);
		const clock = new SimulatedClock();
		const options: CommerceSweepOptions = {
			cursors: memoryCursors(),
			queryBudget: 100_000,
			tickClock: clock.read,
			emailSenderFactory: async (requestTimeoutMs) => ({
				async send(input) {
					if (String(input.data.orderId).endsWith("-a")) {
						clock.advance(requestTimeoutMs());
						throw new EmailSendTimeoutError(requestTimeoutMs());
					}
				},
			}),
		};
		for (let tick = 0; tick < 2; tick++) {
			clock.reset();
			await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
		}
		for (const entry of await outboxOf(`${suffix}-b`)) expect(entry.status).toBe("sent");
		// The stuck one is backed off and still unparked, its timeout recorded.
		for (const entry of await outboxOf(`${suffix}-a`)) {
			expect(entry.status).toBe("pending");
			expect(entry.attempts).toBe(0);
			expect(entry.timeouts).toBe(1);
		}
	}, 120_000);

	test("a send that hangs BEFORE its request (e.g. the host's DNS lookup, deaf to our abort) is cut off by the timer", async () => {
		const suffix = `prereq-${crypto.randomUUID()}`;
		await placePaidOrder(`${suffix}-1`);
		const clock = new SimulatedClock();
		// A small budget so the real timer is short: the outbox's share leaves
		// ~600 ms for the send.
		const options: CommerceSweepOptions = {
			cursors: memoryCursors(),
			queryBudget: 100_000,
			budgetMs: 1000,
			tickClock: clock.read,
			emailSenderFactory: async () => ({
				send: () => new Promise<void>(() => {}), // never settles, ignores every signal
			}),
		};
		const started = Date.now();
		const summary = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(outcome(summary, "order-emails").count).toBe(0);
		for (const entry of await outboxOf(`${suffix}-1`)) {
			expect(entry.status).toBe("pending");
			expect(entry.attempts).toBe(0);
		}
	}, 120_000);

	test("the LIST is bounded: a large, slow hold backlog never reads whole inside the hook", async () => {
		const suffix = `list-${crypto.randomUUID()}`;
		await seedExpiredHolds(suffix, 30);
		const clock = new SimulatedClock();
		// 100 ms a call: listing all 30 holds with their per-row reads would by
		// itself outlast the hook's timeout.
		const ctx = context(slowStorage(storage, clock, 100));
		await runCommerceSweeps(ctx, SWEEP_TASK_NAME, baseOptions({ tickClock: clock.read }));
		expect(clock.elapsed()).toBeLessThanOrEqual(SWEEP_TICK_BUDGET_MS);
		// Drain the rest so later cases start clean.
		await runCommerceSweeps(
			context(storage),
			SWEEP_TASK_NAME,
			baseOptions({ expiryBatchLimit: 100 }),
		);
	}, 120_000);

	test("the tick stays inside its query budget, and defers the rest to the next tick", async () => {
		const suffix = `queries-${crypto.randomUUID()}`;
		await seedExpiredHolds(suffix, 12);
		await placePaidOrder(`${suffix}-1`);
		const counter = { calls: 0 };
		const options = { ...baseOptions(), queryBudget: SWEEP_TICK_QUERY_BUDGET };
		const ctx = context(countingStorage(storage, counter));

		const first = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options);
		expect(counter.calls).toBeLessThanOrEqual(SWEEP_TICK_QUERY_BUDGET);
		expect(first.legs.some((entry) => entry.deferred === true || entry.incomplete === true)).toBe(
			true,
		);
		for (const entry of first.legs) expect(entry.ok).toBe(true);

		// Bite by bite, it all drains.
		let reclaimed = outcome(first, "expire-holds").count;
		for (let i = 0; i < 30 && reclaimed < 12; i++) {
			counter.calls = 0;
			const next = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options);
			expect(counter.calls).toBeLessThanOrEqual(SWEEP_TICK_QUERY_BUDGET);
			reclaimed += outcome(next, "expire-holds").count;
		}
		expect(reclaimed).toBe(12);
	}, 120_000);
});

describe("the query budget is an operational setting (Background work per minute)", () => {
	/** No `queryBudget` override: these cases are about where the budget comes from. */
	function settingOptions(): CommerceSweepOptions {
		return { cursors: memoryCursors(), emailSender: recordingSender([]) };
	}

	test("the default is the Workers Free preset, with Free-sized batches", async () => {
		expect(DEFAULT_BACKGROUND_WORK).toBe(30);
		expect(BACKGROUND_WORK_PRESETS.map((preset) => preset.value)).toEqual([30, 600]);
		const summary = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, settingOptions());
		expect(summary.budget).toMatchObject({
			timeMs: SWEEP_TICK_BUDGET_MS,
			queries: 30,
			expiryBatch: 1,
			emailBatch: 1,
		});
	}, 120_000);

	test("the Workers Paid preset scales the budget and the batches; the time budget still applies", async () => {
		const summary = await runCommerceSweeps(
			context(storage, { [BACKGROUND_WORK_KEY]: 600 }),
			SWEEP_TASK_NAME,
			settingOptions(),
		);
		// Sized from the MEASURED unit costs (a hold flip is ~14 calls), not hoped.
		expect(summary.budget).toMatchObject({
			timeMs: SWEEP_TICK_BUDGET_MS,
			queries: 600,
			expiryBatch: 18,
			emailBatch: 15,
		});
	}, 120_000);

	test("a Paid budget drains a backlog the Free one only nibbles", async () => {
		const suffix = `paid-${crypto.randomUUID()}`;
		// The size of backlog QA saw due in one tick.
		await seedExpiredHolds(suffix, 15);
		const summary = await runCommerceSweeps(
			context(storage, { [BACKGROUND_WORK_KEY]: 600 }),
			SWEEP_TASK_NAME,
			settingOptions(),
		);
		expect(outcome(summary, "expire-holds").count).toBe(15);
	}, 120_000);

	test("the setting is read once per tick, and that read counts against the budget", async () => {
		const counter = { calls: 0 };
		const ctx = context(countingStorage(storage, counter), { [BACKGROUND_WORK_KEY]: 600 }, () => {
			counter.calls++;
		});
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, settingOptions());
		// Every storage and kv call the tick made — the setting's own read among
		// them — is in the budget's count. (The cursors here are in memory.)
		expect(summary.budget.queriesUsed).toBe(counter.calls);
		expect(summary.budget.queriesUsed).toBeGreaterThan(0);
	}, 120_000);

	test("the floor is the Free preset, and it is pinned against the leg cost table", () => {
		expect(MIN_BACKGROUND_WORK).toBe(DEFAULT_BACKGROUND_WORK);
		// The smallest budget at which each critical leg can still start with one
		// unit inside its share, the reserve kept back — from LEG_QUERY_COSTS.
		expect(MIN_BACKGROUND_WORK).toBeGreaterThanOrEqual(minimumQueryBudget());
	});

	test("at the lowest allowed setting, every critical leg makes progress through a backlog on all of them", async () => {
		const suffix = `floor-${crypto.randomUUID()}`;
		await seedExpiredHolds(suffix, 6);
		for (const n of [1, 2, 3]) await placeExpirableOrder(`${suffix}-o${String(n)}`);
		for (const n of [1, 2, 3]) await placePaidOrder(`${suffix}-p${String(n)}`);
		const ctx = context(storage, { [BACKGROUND_WORK_KEY]: MIN_BACKGROUND_WORK });
		const progressed = new Set<string>();
		const start = Date.now();
		// One cursor store across the ticks, as `ctx.kv` is in production: the
		// fairness rule ages a passed-over leg from the state it keeps there.
		const cursors = memoryCursors();
		for (let minute = 0; minute < 6; minute++) {
			const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				now: new Date(start + minute * MINUTE_MS),
			});
			expect(summary.budget.queries).toBe(MIN_BACKGROUND_WORK);
			for (const entry of summary.legs) if (entry.count > 0) progressed.add(entry.leg);
		}
		for (const leg of CRITICAL_LEGS) expect(progressed, leg).toContain(leg);
		// Drain the rest so later cases start clean.
		await runCommerceSweeps(
			context(storage),
			SWEEP_TASK_NAME,
			baseOptions({ expiryBatchLimit: 100 }),
		);
	}, 120_000);

	test("a stored value outside the bounds is ignored for the Free preset, never trusted", async () => {
		for (const stored of [5, 10, 29, 100_000, "lots", -1]) {
			const summary = await runCommerceSweeps(
				context(storage, { [BACKGROUND_WORK_KEY]: stored }),
				SWEEP_TASK_NAME,
				settingOptions(),
			);
			expect(summary.budget.queries).toBe(30);
		}
	}, 120_000);
});

describe("dead carts at the listing step (Free budget)", () => {
	test("lapsed lines whose reservation is no longer live are healed out of the candidate set, so a live hold behind them expires", async () => {
		const suffix = `dead-${crypto.randomUUID()}`;
		const s = stores(new Date(Date.now() - HOUR_MS));
		// Dead carts FIRST, so they sort ahead of the live one: each has a lapsed
		// line whose reservation was released behind the cart's back — a hold
		// `expireHold` will refuse forever. More of them than one Free tick lists.
		for (let i = 0; i < 8; i++) {
			const sku = `DEAD-${suffix}-${String(i)}`;
			await s.inventory.seedOnHand(toSku(sku), 1);
			const key = idempotencyKey(`dead-${suffix}-${String(i)}`);
			const held = await s.inventory.reserve(toSku(sku), 1, key);
			if (!held.ok) throw new Error(held.reason);
			const cartId = await s.cartStore.create(currency("USD"));
			await s.cartStore.upsertLine({
				cartId,
				sku,
				productId: null,
				qty: 1,
				reservationId: held.reservationId,
				expiresAt: new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
				key,
			});
			await s.inventory.release(held.reservationId);
		}
		await seedExpiredHolds(suffix, 1); // the live one, behind them
		const live = toSku(`BUDGET-${suffix}`);
		expect(await s.inventory.getOnHand(live)).toBe(0);

		// The default (Free) budget, as a store on Workers Free runs it.
		const ctx = context(storage);
		const start = Date.now();
		// One cursor store across the ticks, as `ctx.kv` is in production (the tick's
		// fairness state lives there).
		const cursors = memoryCursors();
		for (let tick = 0; tick < 8 && (await s.inventory.getOnHand(live)) === 0; tick++) {
			await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				now: new Date(start + tick * MINUTE_MS),
			});
		}
		expect(await s.inventory.getOnHand(live)).toBe(1);
	}, 120_000);
});

describe("the hook's own bookkeeping", () => {
	beforeEach(() => {
		resetSweepBootstrapForTest();
	});

	test("the budget starts at hook entry, and the task is re-affirmed once per isolate, not every tick", async () => {
		const clock = new SimulatedClock();
		let upserts = 0;
		const ctx = {
			...context(storage),
			cron: {
				async schedule() {
					upserts++;
					clock.advance(700); // a slow registration write
				},
				async cancel() {},
				async list() {
					return [];
				},
			},
		} as PluginContext;
		const handler = createCronHandler(
			baseOptions({ tickClock: clock.read, budgetMs: 600 }) as never,
		);
		const event = { name: SWEEP_TASK_NAME, scheduledAt: new Date().toISOString() };

		// The registration ate the whole (tiny) budget before any leg began.
		const first = (await handler(event, ctx)) as CommerceSweepSummary;
		expect(upserts).toBe(1);
		for (const entry of first.legs) expect(entry.deferred).toBe(true);

		clock.reset();
		const second = (await handler(event, ctx)) as CommerceSweepSummary;
		expect(upserts).toBe(1); // latched: no per-minute write, no next-run nudge
		expect(second.legs.some((entry) => entry.deferred !== true)).toBe(true);
	}, 120_000);

	test("re-affirmation writes only when the registered schedule differs", async () => {
		let upserts = 0;
		let registered = "*/15 * * * *";
		const ctx = {
			...context(storage),
			cron: {
				async schedule(_name: string, opts: { schedule: string }) {
					upserts++;
					registered = opts.schedule;
				},
				async cancel() {},
				async list() {
					return [{ name: SWEEP_TASK_NAME, schedule: registered, nextRunAt: "", lastRunAt: null }];
				},
			},
		} as PluginContext;
		await ensureSweepTaskScheduled(ctx); // old cadence → rewritten
		expect(upserts).toBe(1);
		expect(registered).toBe(SWEEP_SCHEDULE);
		await ensureSweepTaskScheduled(ctx); // already current → read only
		expect(upserts).toBe(1);
	});
});

describe("bounded expiry batches", () => {
	test("expire-holds takes at most its batch per tick, and the coupon sweeper no longer waits for a drained expire-orders", async () => {
		const suffix = `batch-${crypto.randomUUID()}`;
		await seedExpiredHolds(suffix, 3);
		await placeExpirableOrder(`${suffix}-o1`);
		await placeExpirableOrder(`${suffix}-o2`);
		const options = baseOptions({ expiryBatchLimit: 1 });

		const first = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, options);
		expect(outcome(first, "expire-holds")).toMatchObject({ ok: true, count: 1, incomplete: true });
		expect(outcome(first, "expire-orders")).toMatchObject({ ok: true, count: 1, incomplete: true });
		// QA2 M2: the coupon sweeper used to defer itself until expire-orders drained —
		// under a Free backlog, for hours. It now runs, and stops its walk at an order
		// the expiry has not reached yet instead (cron-sweeps.sandbox pins that).
		expect(outcome(first, "coupon-orphans").deferred).toBeUndefined();

		const drained = baseOptions({ expiryBatchLimit: 100 });
		const second = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, drained);
		expect(outcome(second, "expire-holds").count).toBeGreaterThanOrEqual(2);
		expect(outcome(second, "expire-holds").incomplete).toBeUndefined();
		expect(outcome(second, "expire-orders").incomplete).toBeUndefined();
		expect(outcome(second, "coupon-orphans").deferred).toBeUndefined();
	}, 120_000);

	test("the outbox reports `incomplete` when its batch ran out before the outbox did", async () => {
		const suffix = `emailbatch-${crypto.randomUUID()}`;
		for (const n of [1, 2, 3]) await placePaidOrder(`${suffix}-${String(n)}`);
		const summary = await runCommerceSweeps(
			context(storage),
			SWEEP_TASK_NAME,
			baseOptions({ emailBatchLimit: 1 }),
		);
		expect(outcome(summary, "order-emails")).toMatchObject({ count: 1, incomplete: true });
		// Drain.
		await runCommerceSweeps(
			context(storage),
			SWEEP_TASK_NAME,
			baseOptions({ emailBatchLimit: 25 }),
		);
	}, 120_000);

	test("a zero, negative or NaN batch limit fails its leg loudly instead of sweeping nothing forever", async () => {
		for (const expiryBatchLimit of [0, -1, Number.NaN]) {
			const summary = await runCommerceSweeps(
				context(storage),
				SWEEP_TASK_NAME,
				baseOptions({ expiryBatchLimit }),
			);
			const holds = summary.legs.find((entry) => entry.leg === "expire-holds");
			expect(holds).toMatchObject({ ok: false });
			expect(holds?.error).toMatch(/positive integer/);
		}
	}, 120_000);
});

describe("per-leg cadence", () => {
	test("the scan legs run on the first tick, are not due a minute later, and run again fifteen minutes on", async () => {
		const cursors = memoryCursors();
		const start = new Date();
		const at = (offsetMs: number) =>
			baseOptions({ cursors, now: new Date(start.getTime() + offsetMs) });

		const first = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, at(0));
		for (const leg of MAINTENANCE_LEGS) expect(outcome(first, leg).notDue).toBeUndefined();

		const next = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, at(MINUTE_MS));
		for (const leg of MAINTENANCE_LEGS) {
			expect(outcome(next, leg)).toMatchObject({ ok: true, notDue: true, count: 0 });
		}
		// The every-tick legs still ran.
		for (const leg of SWEEP_LEGS.filter((name) => !MAINTENANCE_LEGS.includes(name))) {
			expect(outcome(next, leg).notDue).toBeUndefined();
		}

		const later = await runCommerceSweeps(
			context(storage),
			SWEEP_TASK_NAME,
			at(MAINTENANCE_LEG_INTERVAL_MS),
		);
		for (const leg of MAINTENANCE_LEGS) expect(outcome(later, leg).notDue).toBeUndefined();
	}, 120_000);

	test("a FAILED scan is stamped: it retries at its own cadence, not every minute", async () => {
		const cursors = memoryCursors();
		const start = new Date();
		const ctx = context(failingCollection(storage, PRODUCT_COMMERCE_COLLECTION));
		const at = (offsetMs: number) =>
			baseOptions({ cursors, now: new Date(start.getTime() + offsetMs) });

		const first = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, at(0));
		expect(first.legs.find((entry) => entry.leg === "sku-transfers")).toMatchObject({ ok: false });
		const next = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, at(MINUTE_MS));
		expect(outcome(next, "sku-transfers")).toMatchObject({ notDue: true });
		const later = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, at(MAINTENANCE_LEG_INTERVAL_MS));
		expect(later.legs.find((entry) => entry.leg === "sku-transfers")).toMatchObject({ ok: false });
	}, 120_000);

	test("a scan leg the budget deferred is due again on the very next tick", async () => {
		const cursors = memoryCursors();
		const clock = new SimulatedClock();
		const start = new Date();
		// A budget of zero defers everything; the stamps must not move.
		const starved = await runCommerceSweeps(context(storage), SWEEP_TASK_NAME, {
			...baseOptions({ cursors, now: start, tickClock: clock.read }),
			budgetMs: 0,
		});
		for (const leg of SWEEP_LEGS) expect(outcome(starved, leg).deferred).toBe(true);

		const next = await runCommerceSweeps(
			context(storage),
			SWEEP_TASK_NAME,
			baseOptions({ cursors, now: new Date(start.getTime() + MINUTE_MS) }),
		);
		for (const leg of MAINTENANCE_LEGS) {
			expect(outcome(next, leg).notDue).toBeUndefined();
			expect(outcome(next, leg).deferred).toBeUndefined();
		}
	}, 120_000);
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** A tick clock a case moves by hand. `read` is bound so it can be passed bare. */
class SimulatedClock {
	#start = 0;
	#now = 0;
	readonly read = (): number => this.#now;
	advance(ms: number): void {
		this.#now += ms;
	}
	elapsed(): number {
		return this.#now - this.#start;
	}
	reset(): void {
		this.#start = this.#now;
	}
}

/** The real store, with every collection call costing `ms` of simulated time —
 *  what a slow database round trip does to the tick's real clock. */
function slowStorage(base: StorageAccess, clock: SimulatedClock, ms: number): StorageAccess {
	return wrapCollections(base, () => clock.advance(ms));
}

/** Fresh cursors (so a case never inherits another's window), an email sender
 *  that cannot egress, and — unless a case is ABOUT the query budget — no query
 *  cap, so a time-budget case is governed by time alone. */
function baseOptions(over: Partial<CommerceSweepOptions> = {}): CommerceSweepOptions {
	return {
		cursors: memoryCursors(),
		emailSender: recordingSender([]),
		queryBudget: 100_000,
		...over,
	};
}

/** The real store, counting every collection call — one D1 query each. */
function countingStorage(base: StorageAccess, counter: { calls: number }): StorageAccess {
	return wrapCollections(base, () => {
		counter.calls++;
	});
}

/** The real store, with one collection whose every call throws. */
function failingCollection(base: StorageAccess, name: string): StorageAccess {
	const wrapped: StorageAccess = { ...base };
	const collection = base[name];
	if (collection === undefined) throw new Error(`no collection ${name}`);
	wrapped[name] = new Proxy(collection, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return () => Promise.reject(new Error(`${name} is down`));
		},
	});
	return wrapped;
}

function wrapCollections(base: StorageAccess, onCall: () => void): StorageAccess {
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(base)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					onCall();
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}

function recordingSender(sent: SendEmailInput[], onSend?: () => void): EmailSender {
	return {
		async send(input) {
			onSend?.();
			sent.push(input);
		},
	};
}

function memoryCursors(): SweepCursorStore {
	const store = new Map<string, string>();
	return {
		async read(name) {
			return store.get(name) ?? null;
		},
		async write(name, value) {
			store.set(name, value);
		},
	};
}

function context(
	store: StorageAccess,
	seed: Record<string, unknown> = {},
	onKvCall?: () => void,
): PluginContext {
	const kv = new Map<string, unknown>(Object.entries(seed));
	return {
		http: {
			fetch() {
				throw new Error("a sweep must not make an HTTP request");
			},
		},
		kv: {
			async get<T>(key: string): Promise<T | null> {
				onKvCall?.();
				return kv.has(key) ? (kv.get(key) as T) : null;
			},
			async set(key: string, value: unknown): Promise<void> {
				onKvCall?.();
				kv.set(key, value);
			},
			async delete(key: string): Promise<boolean> {
				return kv.delete(key);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
		storage: store,
	} as unknown as PluginContext;
}

function outcome(summary: CommerceSweepSummary, name: SweepLeg): SweepLegOutcome {
	const found = summary.legs.find((entry) => entry.leg === name);
	if (found === undefined) throw new Error(`no ${name} leg in the summary`);
	if (!found.ok) throw new Error(`${name} failed: ${found.error ?? "unknown"}`);
	return found;
}

function stores(at?: Date) {
	const clock = at === undefined ? systemClock : new FixedClock(at);
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock });
	return {
		inventory,
		cartStore: new EmdashCartStore({ storage, inventory, idGen: uuidIdGen, clock }),
		orderStore: new EmdashOrderStore({ storage, inventory, idGen: uuidIdGen, clock }),
	};
}

/** `n` real cart holds of one unit each, on one sku seeded with exactly `n`, all
 *  past their deadline by the wall clock. */
async function seedExpiredHolds(suffix: string, n: number): Promise<string[]> {
	const s = stores(new Date(Date.now() - HOUR_MS));
	const sku = `BUDGET-${suffix}`;
	await s.inventory.seedOnHand(toSku(sku), n);
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const key = idempotencyKey(`line-${suffix}-${String(i)}`);
		const held = await s.inventory.reserve(toSku(sku), 1, key);
		if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
		const cartId = await s.cartStore.create(currency("USD"));
		await s.cartStore.upsertLine({
			cartId,
			sku,
			productId: null,
			qty: 1,
			reservationId: held.reservationId,
			expiresAt: new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
			key,
		});
		ids.push(held.reservationId);
	}
	expect(await s.inventory.getOnHand(toSku(sku))).toBe(0);
	return ids;
}

/** A physical order over one real adopted reservation. */
async function placeOrder(suffix: string, holdExpiresAt: string): Promise<string> {
	const s = stores(new Date(Date.now() - HOUR_MS));
	const sku = `BUDGET-O-${suffix}`;
	await s.inventory.seedOnHand(toSku(sku), 10);
	const held = await s.inventory.reserve(toSku(sku), 1, idempotencyKey(`res-${suffix}`));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	await s.inventory.stampHoldDeadline(
		held.reservationId,
		new Date(Date.now() + DAY_MS).toISOString(),
	);
	const id = `order-${suffix}`;
	await s.inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId(id),
		holdExpiresAt,
		now: new Date(Date.now() - HOUR_MS).toISOString(),
	});
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-${suffix}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${suffix}`),
		holdExpiresAt,
		buyerRef: `buyer-${suffix}@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${suffix}`),
				sku: toSku(sku),
				title: "Budget Widget",
				unitPrice: cents(1000),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: currency("USD") },
	});
	return id;
}

async function placeExpirableOrder(suffix: string): Promise<string> {
	return await placeOrder(suffix, new Date(Date.now() - 30 * MINUTE_MS).toISOString());
}

/** The order's outbox entries, read straight from its document. */
async function outboxOf(suffix: string) {
	const doc = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(`order-${suffix}`);
	return doc?.emailOutbox ?? [];
}

/** A paid order: `markPaid` enqueues the confirmation the outbox drains. */
async function placePaidOrder(suffix: string): Promise<string> {
	const id = await placeOrder(suffix, new Date(Date.now() + DAY_MS).toISOString());
	await stores().orderStore.markPaid(toOrderId(id));
	return id;
}
