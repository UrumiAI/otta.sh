/**
 * The `coupon-recount` leg's walk (issue #619), over real SQLite, through the real
 * sweep runner with every other leg stubbed out.
 *
 * The store's half — when a recount may write, and what it must never lose — is the
 * domain contract plus the store-emdash interleaving and race suites. This file is
 * the leg's half:
 *
 * - the rotation: ten coupons a run, across the page seam, wrapping at the end;
 * - the RECHECK: a kept observation is confirmed about one settle window after it
 *   was made, before the rotation comes round again, so a big catalog does not
 *   delay it by a whole pass;
 * - the cap on kept observations, and the dropping of stale ones;
 * - a coupon whose recount throws: logged, passed over (never pinning the
 *   rotation), the cursor still saved, and the corrections made before it still
 *   logged.
 */
import {
	cents,
	COUPON_RECOUNT_SETTLE_MS,
	currency,
	type CouponUsesObservation,
} from "@urumi.ai/otta-domain";
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import {
	collectionOf,
	COUPONS_COLLECTION,
	EmdashCouponStore,
	uuidIdGen,
	type CouponDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepSummary,
	type SweepCursorStore,
} from "../src/cron/index.js";
import {
	COUPON_RECOUNT_MAX_SEEN,
	COUPON_RECOUNT_RECHECKS_PER_TICK,
	COUPON_RECOUNTS_PER_TICK,
	MAINTENANCE_LEG_INTERVAL_MS,
	SWEEP_LEGS,
} from "../src/cron/sweeps.js";
import { memoryCursors, MINUTE_MS, sweepContext } from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const T0 = new Date("2026-10-05T12:00:00.000Z");
const PAID = 600;
/** One host page: a catalog past it has a page seam. */
const PAGE = 100;

let storage: StorageAccess;
let errors: string[];

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	errors = [];
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** `n` coupons, created a second apart from `T0` minus a day (so `id` order is
 *  creation order) — or all in one instant — `c-000`, `c-001`, …; each listed in `drifted` has its counter
 *  set to 1 with no redemption behind it. */
async function seedCoupons(
	n: number,
	drifted: readonly number[] = [],
	sameInstant = false,
): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = `c-${String(i).padStart(3, "0")}`;
		const offset = sameInstant ? 0 : i * 1000;
		const clock = new FixedClock(new Date(T0.getTime() - 24 * 60 * MINUTE_MS + offset));
		await new EmdashCouponStore({ storage, idGen: uuidIdGen, clock }).create({
			id,
			code: `CODE${String(i)}`,
			type: "percentage",
			amountCents: null,
			rateBps: 1000,
			capCents: null,
			currency: currency("USD"),
			minSubtotalCents: cents(0),
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		ids.push(id);
	}
	for (const i of drifted) await setUses(ids[i] ?? "", 1);
	return ids;
}

async function setUses(id: string, usesCount: number): Promise<void> {
	const docs = collectionOf<CouponDoc>(storage, COUPONS_COLLECTION);
	const doc = await docs.getVersioned(id);
	if (doc === null) throw new Error(`no coupon ${id}`);
	expect((await docs.compareAndSet(id, doc.revision, { ...doc.value, usesCount })).applied).toBe(
		true,
	);
}

async function usesOf(id: string): Promise<number | undefined> {
	return (await collectionOf<CouponDoc>(storage, COUPONS_COLLECTION).get(id))?.usesCount;
}

const OTHERS = Object.fromEntries(
	SWEEP_LEGS.filter((name) => name !== "coupon-recount").map((name) => [name, async () => 0]),
);

/** One tick at `at`, only the recount leg live. */
async function tick(
	cursors: SweepCursorStore,
	at: Date,
	store: StorageAccess = storage,
): Promise<CommerceSweepSummary["legs"][number]> {
	const summary = await runCommerceSweeps(
		sweepContext(store, undefined, { [BACKGROUND_WORK_KEY]: PAID }),
		SWEEP_TASK_NAME,
		{ cursors, now: at, legBodies: OTHERS },
	);
	const found = summary.legs.find((entry) => entry.leg === "coupon-recount");
	if (found === undefined) throw new Error("no coupon-recount leg in the summary");
	return found;
}

interface RecountRecord {
	cursor: string | null;
	skip: number;
	seen: Record<string, CouponUsesObservation & { code?: string }>;
}

async function record(cursors: SweepCursorStore): Promise<RecountRecord> {
	const raw = await cursors.read("coupon-recount");
	return raw === null ? { cursor: null, skip: 0, seen: {} } : (JSON.parse(raw) as RecountRecord);
}

/** The store, with every coupon a recount JUDGES recorded (a recount reads its
 *  coupon with one versioned read; nothing else in the leg does). */
function judging(): { store: StorageAccess; take(): string[] } {
	let judged: string[] = [];
	const store: StorageAccess = { ...storage };
	const coupons = collectionOf<CouponDoc>(storage, COUPONS_COLLECTION);
	store[COUPONS_COLLECTION] = new Proxy(coupons, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (prop !== "getVersioned" || typeof value !== "function") return value;
			return async (id: string) => {
				judged.push(id);
				return await (value as (id: string) => Promise<unknown>).call(target, id);
			};
		},
	}) as StorageAccess[string];
	return {
		store,
		take() {
			const taken = judged;
			judged = [];
			return taken;
		},
	};
}

/** One whole pass at `at`: the coupons each run judged, until the pass wraps. */
async function pass(
	cursors: SweepCursorStore,
	at: Date,
	recorder: ReturnType<typeof judging>,
): Promise<string[][]> {
	const runs: string[][] = [];
	for (let i = 0; i < 40; i++) {
		const leg = await tick(cursors, at, recorder.store);
		expect(leg.ok).toBe(true);
		runs.push(recorder.take());
		if (leg.incomplete !== true) return runs;
	}
	throw new Error("the pass never wrapped in 40 runs");
}

const minutes = (n: number): Date => new Date(T0.getTime() + n * MINUTE_MS);

test("the rotation judges ten a run, crosses the page seam and wraps, every coupon once", async () => {
	const ids = await seedCoupons(PAGE + 15);
	const cursors = memoryCursors();
	// One instant throughout: no observation settles, so every run is rotation.
	const runs = await pass(cursors, T0, judging());
	for (const run of runs) expect(run.length).toBeLessThanOrEqual(COUPON_RECOUNTS_PER_TICK);
	expect(runs).toHaveLength(Math.ceil(ids.length / COUPON_RECOUNTS_PER_TICK));
	// In order, across the page seam, none twice and none missed.
	expect(runs.flat()).toEqual(ids);
	// Wrapped: the next pass starts again from the beginning.
	expect(await record(cursors)).toMatchObject({ cursor: null, skip: 0 });
	// And the leg is done for the cadence.
	expect((await tick(cursors, minutes(1))).notDue).toBe(true);
});

test("a createdAt group bigger than a page is walked through: its last coupon is judged and corrected", async () => {
	// One instant for all: only the host's keyset cursor reaches past the first page.
	const ids = await seedCoupons(PAGE + 5, [PAGE + 4], true);
	const last = ids[PAGE + 4] ?? "";
	const cursors = memoryCursors();
	const recorder = judging();
	const runs = await pass(cursors, T0, recorder);
	expect(runs.flat().toSorted()).toEqual(ids);
	expect(Object.keys((await record(cursors)).seen)).toEqual([last]);
	// A cadence on, its recheck confirms it.
	await tick(cursors, minutes(1 + MAINTENANCE_LEG_INTERVAL_MS / MINUTE_MS), recorder.store);
	expect(await usesOf(last)).toBe(0);
});

test("rechecks never take the whole allowance: the rotation moves on every run", async () => {
	// Ten drifted coupons with settled observations that no longer match (a redeem
	// voided each), so every one is due for a recheck on every run.
	const ids = await seedCoupons(
		COUPON_RECOUNTS_PER_TICK + 5,
		Array.from({ length: COUPON_RECOUNTS_PER_TICK }, (_, i) => i + 5),
	);
	const busy = ids.slice(5);
	const cursors = memoryCursors();
	const now = minutes(60);
	const stale = new Date(now.getTime() - COUPON_RECOUNT_SETTLE_MS).toISOString();
	await cursors.write(
		"coupon-recount",
		JSON.stringify({
			cursor: null,
			skip: 0,
			seen: Object.fromEntries(
				busy.map((id) => [
					id,
					{ couponId: id, usesCount: 1, liveUses: 0, version: "voided", observedAt: stale },
				]),
			),
		}),
	);
	const recorder = judging();
	await tick(cursors, now, recorder.store);
	const judged = recorder.take();
	expect(judged.filter((id) => busy.includes(id))).toHaveLength(COUPON_RECOUNT_RECHECKS_PER_TICK);
	// The rest of the allowance went to the rotation, from the top of the catalog.
	expect(judged.filter((id) => !busy.includes(id))).toEqual(
		ids.slice(0, COUPON_RECOUNTS_PER_TICK - COUPON_RECOUNT_RECHECKS_PER_TICK),
	);
	// And the rotation's place moved past them.
	expect((await record(cursors)).cursor).not.toBeNull();
});

test("a drifted coupon is confirmed by its recheck a settle window on, long before the rotation comes round", async () => {
	// The first coupon drifts; the catalog is big enough that a pass takes 12 runs.
	const ids = await seedCoupons(PAGE + 15, [0, PAGE + 10]);
	const first = ids[0] ?? "";
	const late = ids[PAGE + 10] ?? "";
	const cursors = memoryCursors();
	// One run a minute, as the leg runs while a pass is unfinished.
	await tick(cursors, minutes(0));
	expect(Object.keys((await record(cursors)).seen)).toEqual([first]);
	expect(await usesOf(first)).toBe(1);
	let minute = 1;
	for (; minute < COUPON_RECOUNT_SETTLE_MS / MINUTE_MS; minute++)
		await tick(cursors, minutes(minute));
	// Inside the window: still only observed.
	expect(await usesOf(first)).toBe(1);
	// The first run past it rechecks the first coupon by id, mid-pass.
	const settled = await tick(cursors, minutes(minute));
	expect(settled.count).toBe(1);
	expect(await usesOf(first)).toBe(0);
	expect(settled.incomplete).toBe(true);
	// The correction was logged at once, by code and id.
	expect(errors.some((line) => line.includes(`coupon CODE0 (${first})`))).toBe(true);
	expect(errors.some((line) => line.includes("usesCount 1 corrected to 0"))).toBe(true);

	// The late coupon, observed near the pass's end, is confirmed a settle window
	// after ITS first look — by a recheck, not a second pass.
	for (minute++; minute < 40 && (await usesOf(late)) !== 0; minute++) {
		await tick(cursors, minutes(minute));
	}
	expect(await usesOf(late)).toBe(0);
	const observedLate = 11; // its run in the pass: the 11th
	expect(minute).toBeLessThanOrEqual(
		observedLate + 1 + (COUPON_RECOUNT_SETTLE_MS + MAINTENANCE_LEG_INTERVAL_MS) / MINUTE_MS,
	);
	expect((await record(cursors)).seen).toEqual({});
});

test("at most COUPON_RECOUNT_MAX_SEEN observations are kept; the rest are observed again", async () => {
	const n = COUPON_RECOUNT_MAX_SEEN + 5;
	const ids = await seedCoupons(
		n,
		Array.from({ length: n }, (_, i) => i),
	);
	const cursors = memoryCursors();
	for (let i = 0; i < 30; i++) {
		// One instant: nothing settles, so every drifted coupon is a first look.
		if ((await tick(cursors, T0)).incomplete !== true) break;
	}
	const seen = Object.keys((await record(cursors)).seen);
	expect(seen).toHaveLength(COUPON_RECOUNT_MAX_SEEN);
	// The first hundred in rotation order were kept; the last five wait their turn.
	expect(seen.toSorted()).toEqual(ids.slice(0, COUPON_RECOUNT_MAX_SEEN));
	for (const id of ids) expect(await usesOf(id)).toBe(1);
});

/** A kept observation of `couponId`, made at `at`. */
function observation(couponId: string, at: Date): CouponUsesObservation {
	return {
		couponId,
		usesCount: 2,
		liveUses: 0,
		version: "v",
		observedAt: at.toISOString(),
	};
}

test("a kept observation of a deleted coupon is dropped by its recheck, however old; an unreadable or future one is dropped unread", async () => {
	await seedCoupons(1);
	const cursors = memoryCursors();
	const now = minutes(60);
	await cursors.write(
		"coupon-recount",
		JSON.stringify({
			cursor: null,
			skip: 0,
			seen: {
				// Settled: rechecked, not found, forgotten.
				"gone-settled": observation(
					"gone-settled",
					new Date(now.getTime() - COUPON_RECOUNT_SETTLE_MS),
				),
				// Hours old (a starved leg's runs can be far apart): still rechecked, and
				// only then forgotten — age alone never drops an observation.
				"gone-old": observation("gone-old", new Date(now.getTime() - 120 * MINUTE_MS)),
				// An unreadable time and a future one: dropped too.
				"gone-garbled": { ...observation("gone-garbled", now), observedAt: "not-a-time" },
				"gone-ahead": observation("gone-ahead", new Date(now.getTime() + MINUTE_MS)),
			},
		}),
	);
	const recorder = judging();
	const leg = await tick(cursors, now, recorder.store);
	expect(leg.ok).toBe(true);
	expect((await record(cursors)).seen).toEqual({});
	const judged = recorder.take();
	expect(judged).toEqual(expect.arrayContaining(["gone-settled", "gone-old"]));
	expect(judged).not.toContain("gone-garbled");
	expect(judged).not.toContain("gone-ahead");
});

test("a coupon whose recount throws is logged and passed over: the cursor is saved and the run's corrections stay logged", async () => {
	const ids = await seedCoupons(3, [0, 2]);
	const [a, boom, c] = ids as [string, string, string];
	/** The store, with `boom`'s coupon read failing every time. */
	const failing: StorageAccess = { ...storage };
	const coupons = collectionOf<CouponDoc>(storage, COUPONS_COLLECTION);
	failing[COUPONS_COLLECTION] = new Proxy(coupons, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (prop !== "getVersioned" || typeof value !== "function") return value;
			return async (id: string) => {
				if (id === boom) throw new Error("injected read failure");
				return await (value as (id: string) => Promise<unknown>).call(target, id);
			};
		},
	}) as StorageAccess[string];
	const cursors = memoryCursors();

	// Run 1: `a` observed, `boom` throws. The run ends there, with its cursor PAST
	// `boom`, so the next run does not start on it again.
	const one = await tick(cursors, minutes(0), failing);
	expect(one.ok).toBe(true);
	expect(one.incomplete).toBe(true);
	expect(one.anomalies?.some((line) => line.includes(boom) && line.includes("injected"))).toBe(
		true,
	);
	expect(await record(cursors)).toMatchObject({ cursor: null, skip: 2 });
	expect(Object.keys((await record(cursors)).seen)).toEqual([a]);

	// Run 2: not pinned — `c` is judged and the pass wraps.
	const two = await tick(cursors, minutes(1), failing);
	expect(two.incomplete).not.toBe(true);
	expect(Object.keys((await record(cursors)).seen).toSorted()).toEqual([a, c]);

	// A cadence on: the rechecks correct `a` and `c`, then the rotation reaches
	// `boom`, which throws again. Both corrections were logged when they were made.
	errors = [];
	const three = await tick(cursors, minutes(2 + MAINTENANCE_LEG_INTERVAL_MS / MINUTE_MS), failing);
	expect(three.count).toBe(2);
	expect(await usesOf(a)).toBe(0);
	expect(await usesOf(c)).toBe(0);
	expect(errors.filter((line) => line.includes("corrected to 0"))).toHaveLength(2);
	expect(errors.some((line) => line.includes(`coupon CODE0 (${a})`))).toBe(true);
	expect(errors.some((line) => line.includes(`coupon CODE2 (${c})`))).toBe(true);
});
