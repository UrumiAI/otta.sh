/**
 * The rollup refresh's self-healing (issue #572 review), through the real sweep over
 * real SQLite: the round-robin verifier repairs a clean month document and clean day
 * lines that disagree with what they cache, a day too big to build is skipped loudly
 * rather than heading every batch, and a month held by a claim is healed or backed off
 * without keeping the leg due every tick.
 */
import {
	collectionOf,
	ORDERS_COLLECTION,
	PRODUCTS_UNBUILDABLE,
	REPORTING_APPLIED_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	REPORTING_MONTHLY_COLLECTION,
	type OrderDoc,
	type ReportingAppliedDoc,
	type ReportingDailyStoredDoc,
	type ReportingMonthlyDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { REPORTING_SETTLE_MS, SWEEP_TASK_NAME } from "../src/cron/index.js";
import {
	runCommerceSweeps,
	type CommerceSweepSummary,
	type SweepCursorStore,
} from "../src/cron/sweeps.js";
import { DAY_MS, memoryCursors, placeOrder, sweepContext } from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

let storage: StorageAccess;
let close: () => void;
let errors: string[];

beforeEach(async () => {
	const db = await makeSqliteStorage(commerceStorageLayout());
	storage = db.storage;
	close = () => db.close();
	errors = [];
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errors.push(a.map(String).join(" "));
	});
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	close();
});

const daily = () => collectionOf<ReportingDailyStoredDoc>(storage, REPORTING_DAILY_COLLECTION);
const monthly = () => collectionOf<ReportingMonthlyDoc>(storage, REPORTING_MONTHLY_COLLECTION);

/** One sweep, every maintenance leg due (a fresh kv), past the settle window of
 *  anything written so far. */
async function sweep(
	cursors: SweepCursorStore,
	queryBudget = 100_000,
): Promise<CommerceSweepSummary> {
	// reporting-heal's last run is forgotten each time, so the slow-cadence leg is always
	// due; every other leg keeps its cadence (so a Free-sized tick is not spent on them),
	// and the walk's and the verifier's cursors are kept.
	const due: SweepCursorStore = {
		read: async (name) => {
			const raw = await cursors.read(name);
			if (name !== "state" || raw === null) return raw;
			const state = JSON.parse(raw) as { lastRun?: Record<string, string> };
			delete state.lastRun?.["reporting-heal"];
			return JSON.stringify(state);
		},
		write: async (name, value) => await cursors.write(name, value),
	};
	return await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
		queryBudget,
		cursors: due,
		now: new Date(Date.now() + REPORTING_SETTLE_MS + 60_000),
	});
}

function heal(summary: CommerceSweepSummary) {
	const leg = summary.legs.find((entry) => entry.leg === "reporting-heal");
	if (leg === undefined) throw new Error("reporting-heal did not run");
	return leg;
}

/** An order created `daysAgo` days back (well outside the heal walk's week). */
async function orderDaysAgo(tag: string, daysAgo: number): Promise<{ id: string; day: string }> {
	const at = new Date(Date.now() - daysAgo * DAY_MS);
	const placed = await placeOrder(storage, tag, new Date(Date.now() + DAY_MS), at);
	return { id: placed.id, day: at.toISOString().slice(0, 10) };
}

describe("the verifier", () => {
	test("repairs a clean month document and clean day lines that disagree with what they cache, and says so", async () => {
		const a = await orderDaysAgo("verify-a", 40);
		const b = await orderDaysAgo("verify-b", 80);
		const cursors = memoryCursors();
		await sweep(cursors);
		const months = [a.day.slice(0, 7), b.day.slice(0, 7)];
		for (const month of months) expect(await monthly().get(month)).toMatchObject({ dirty: 0 });

		// Corrupt both caches while they stay CLEAN: nothing about them says they are wrong.
		const doc = (await monthly().get(months[1]!))!;
		await monthly().put(months[1]!, {
			...doc,
			currencies: Object.fromEntries(
				Object.entries(doc.currencies!).map(([c, sums]) => [
					c,
					{ ...sums, stateCounts: { ...sums.stateCounts, pending: 999 } },
				]),
			),
		});
		const dayId = (await daily().query({ where: { date: a.day }, limit: 1 })).items[0]!.id;
		const dayDoc = (await daily().get(dayId))!;
		expect(dayDoc.productsDirty).toBe(0);
		await daily().put(dayId, {
			...dayDoc,
			products: [{ productId: "ghost", title: "Ghost", qty: 1, cents: 1 }],
		});

		// The walk comes round within a few runs; each repair is announced.
		for (let run = 0; run < 8; run++) await sweep(cursors);
		expect(errors.some((l) => l.includes(`reporting ${months[1]!}: the month document`))).toBe(
			true,
		);
		expect(errors.some((l) => l.includes(`reporting ${a.day}: top-products lines`))).toBe(true);
		const repaired = (await monthly().get(months[1]!))!;
		expect(Object.values(repaired.currencies!).every((c) => c.stateCounts.pending !== 999)).toBe(
			true,
		);
		expect((await daily().get(dayId))!.products).toEqual(dayDoc.products);
	}, 120_000);

	test("takes turns with the caught-up walk on a Free-sized tick, and wraps its cursor at the end", async () => {
		const a = await orderDaysAgo("wrap-a", 40);
		const cursors = memoryCursors();
		await sweep(cursors);
		const states: { month: string | null; day: string | null; verifyTurn: boolean }[] = [];
		for (let run = 0; run < 6; run++) {
			await sweep(cursors, 30);
			states.push(
				JSON.parse((await cursors.read("reporting-refresh"))!) as (typeof states)[number],
			);
		}
		// Turns alternate, and the verifier's walk reaches the one month and wraps.
		expect(states.some((st) => st.verifyTurn) && states.some((st) => !st.verifyTurn)).toBe(true);
		expect(states.some((st) => st.month === a.day.slice(0, 7))).toBe(true);
		expect(states.some((st) => st.day !== null)).toBe(true);
		// Days are re-checked newest first: the first one checked is the latest seen.
		const days = states.map((st) => st.day).filter((d): d is string => d !== null);
		expect(days[0]).toBe(days.toSorted().at(-1));
	}, 120_000);

	test("while an upgrade's backfill is pending, one run in four still goes to the walk or the verifier", async () => {
		const cursors = memoryCursors();
		await sweep(cursors);
		// Thirty stale days: a Free tick's refresh builds a couple a run, so the backfill
		// stays pending across the runs below.
		for (let i = 0; i < 30; i++) await orderDaysAgo(`pending-${String(i)}`, 20 + i);
		let walks = 0;
		const watched: SweepCursorStore = {
			read: async (name) => await cursors.read(name),
			write: async (name, value) => {
				if (name === "reporting-heal") walks++;
				await cursors.write(name, value);
			},
		};
		const states: {
			pending: boolean;
			verifyTurn: boolean;
			turn: number;
			month: string | null;
		}[] = [];
		const before = JSON.parse((await cursors.read("reporting-refresh"))!) as {
			month: string | null;
		};
		for (let run = 0; run < 12; run++) {
			await sweep(watched, 30);
			states.push(
				JSON.parse((await cursors.read("reporting-refresh"))!) as (typeof states)[number],
			);
		}
		expect(states.every((st) => st.pending)).toBe(true);
		// Inside the backfill: a maintenance turn re-walked yesterday (and handed the next
		// one to the verifier), and the verifier's turn moved its walk on.
		expect(walks).toBeGreaterThan(1);
		expect(states.some((st) => st.verifyTurn && st.turn === 0)).toBe(true);
		const verified = states.findIndex(
			(st, i) => i > 0 && states[i - 1]!.verifyTurn && !st.verifyTurn,
		);
		expect(verified).toBeGreaterThan(0);
		expect(states[verified]!.month).not.toBe(before.month);
	}, 180_000);
});

describe("the backfill does not wedge", () => {
	test("a day too big to build in any tick is marked unbuildable and announced, and the days behind it are built", async () => {
		// A first, roomy run settles every other leg's cadence, so the Free-sized ticks
		// below are reporting-heal's.
		const cursors = memoryCursors();
		await sweep(cursors);
		const big = await orderDaysAgo("big", 20);
		const older = await orderDaysAgo("older", 30);
		// Clone the big day's order until reading it needs more pages than the Free
		// preset's reporting-heal share could ever pay for.
		const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
		const template = (await orders.get(big.id))!;
		for (let i = 0; i < 1000; i++) {
			await orders.put(`${big.id}-clone-${String(i)}`, {
				...template,
				id: `${big.id}-clone-${String(i)}`,
			} as OrderDoc);
		}
		for (let run = 0; run < 6; run++) await sweep(cursors, 30);

		const bigDocs = await daily().query({ where: { date: big.day }, limit: 10 });
		expect(bigDocs.items.every(({ data }) => data.productsDirty === PRODUCTS_UNBUILDABLE)).toBe(
			true,
		);
		expect(errors.filter((l) => l.includes(`reporting ${big.day}: too many orders`))).toHaveLength(
			1,
		);
		const olderDocs = await daily().query({ where: { date: older.day }, limit: 10 });
		expect(olderDocs.items.every(({ data }) => data.productsDirty === 0)).toBe(true);
	}, 180_000);
});

describe("a month held by a claim", () => {
	async function claim(id: string, date: string, claimedAt: string): Promise<void> {
		await collectionOf<ReportingAppliedDoc>(storage, REPORTING_APPLIED_COLLECTION).put(id, {
			orderId: "nobody",
			kind: "transition",
			date,
			currency: "USD",
			fromState: "paid",
			toState: "shipped",
			refundId: null,
			amountCents: null,
			claimedAt,
			appliedAt: null,
			absorbedAt: null,
		});
	}

	test("a settled claim no recompute can prove is stamped, and the month is built in the same run", async () => {
		const a = await orderDaysAgo("held-old", 40);
		const cursors = memoryCursors();
		await sweep(cursors);
		const month = a.day.slice(0, 7);
		await claim("orphan-old", a.day, new Date(Date.now() - 2 * REPORTING_SETTLE_MS).toISOString());
		await monthly().put(month, { ...(await monthly().get(month))!, dirty: 1 });

		const leg = heal(await sweep(cursors));
		expect(leg.incomplete).toBeUndefined();
		expect(await monthly().get(month)).toMatchObject({ dirty: 0 });
	}, 120_000);

	test("a young claim (an event in flight) leaves the month for a later run without keeping the leg due", async () => {
		const a = await orderDaysAgo("held-young", 40);
		const cursors = memoryCursors();
		await sweep(cursors);
		const month = a.day.slice(0, 7);
		// Young relative to the tick's clock, which `sweep` runs past the settle window.
		await claim("in-flight", a.day, new Date(Date.now() + REPORTING_SETTLE_MS * 2).toISOString());
		await monthly().put(month, { ...(await monthly().get(month))!, dirty: 1 });

		const leg = heal(await sweep(cursors));
		expect(leg.ok).toBe(true);
		expect(leg.incomplete).toBeUndefined();
		expect(await monthly().get(month)).toMatchObject({ dirty: 1 });
	}, 120_000);
});
