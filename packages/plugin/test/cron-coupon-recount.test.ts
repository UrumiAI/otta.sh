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
	COUPON_RECOUNT_SEEN_TTL_MS,
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
	at: string | null;
	id: string | null;
	seen: Record<string, CouponUsesObservation & { code?: string }>;
}

async function record(cursors: SweepCursorStore): Promise<RecountRecord> {
	const raw = await cursors.read("coupon-recount");
	return raw === null ? { at: null, id: null, seen: {} } : (JSON.parse(raw) as RecountRecord);
}

const minutes = (n: number): Date => new Date(T0.getTime() + n * MINUTE_MS);

test("the rotation judges ten a run, crosses the page seam and wraps", async () => {
	const ids = await seedCoupons(PAGE + 15);
	const cursors = memoryCursors();
	const positions: (string | null)[] = [];
	let runs = 0;
	for (; runs < 30; runs++) {
		// One instant throughout: no observation settles, so every run is rotation.
		const leg = await tick(cursors, T0);
		expect(leg.ok).toBe(true);
		positions.push((await record(cursors)).id);
		if (leg.incomplete !== true) break;
	}
	// Ten a run over 115 coupons, plus at most one short run at the seam (the page's
	// last group is left whole for the next page).
	expect(runs + 1).toBeGreaterThanOrEqual(Math.ceil(ids.length / COUPON_RECOUNTS_PER_TICK));
	expect(runs + 1).toBeLessThanOrEqual(Math.ceil(ids.length / COUPON_RECOUNTS_PER_TICK) + 1);
	const walked = positions.slice(0, -1);
	// Strictly forward, and past the seam onto the second page.
	expect(walked).toEqual(walked.toSorted());
	expect(new Set(walked).size).toBe(walked.length);
	// The wrapping run judged what was left after the last saved position: no more
	// than one run's worth.
	const lastSaved = ids.indexOf(walked.at(-1) ?? "");
	expect(ids.length - 1 - lastSaved).toBeGreaterThan(0);
	expect(ids.length - 1 - lastSaved).toBeLessThanOrEqual(COUPON_RECOUNTS_PER_TICK);
	expect(walked.some((id) => id !== null && id > (ids[PAGE - 1] ?? ""))).toBe(true);
	// Wrapped: the next pass starts again from the beginning.
	expect(positions.at(-1)).toBeNull();
	// And the leg is done for the cadence.
	expect((await tick(cursors, minutes(1))).notDue).toBe(true);
});

test("a createdAt group bigger than a page never stalls the rotation", async () => {
	// One instant for all: no `createdAt` bound reaches past the first page.
	await seedCoupons(PAGE + 5, [], true);
	const cursors = memoryCursors();
	let wrapped = false;
	for (let i = 0; i < 30 && !wrapped; i++) wrapped = (await tick(cursors, T0)).incomplete !== true;
	expect(wrapped, "the pass wrapped").toBe(true);
	expect(await record(cursors)).toMatchObject({ at: null, id: null });
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
	const observedLate = 11; // its run in the pass: the 11th or 12th (seam)
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

test("a kept observation of a deleted coupon is dropped: by its recheck, or by age", async () => {
	await seedCoupons(1);
	const cursors = memoryCursors();
	const now = minutes(60);
	await cursors.write(
		"coupon-recount",
		JSON.stringify({
			at: null,
			id: null,
			seen: {
				// Settled: rechecked, not found, forgotten.
				"gone-settled": observation(
					"gone-settled",
					new Date(now.getTime() - COUPON_RECOUNT_SETTLE_MS),
				),
				// Past the age limit: dropped without a look.
				"gone-stale": observation(
					"gone-stale",
					new Date(now.getTime() - COUPON_RECOUNT_SEEN_TTL_MS - 1),
				),
				// An unreadable time and a future one: dropped too.
				"gone-garbled": { ...observation("gone-garbled", now), observedAt: "not-a-time" },
				"gone-ahead": observation("gone-ahead", new Date(now.getTime() + MINUTE_MS)),
			},
		}),
	);
	const leg = await tick(cursors, now);
	expect(leg.ok).toBe(true);
	expect((await record(cursors)).seen).toEqual({});
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
	expect(await record(cursors)).toMatchObject({ id: boom });
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
