/**
 * The `product-orphans` sweep leg (issue #374): a `product_commerce` row whose CMS
 * document is gone is soft-deleted, exactly as the `content:afterDelete` hook would
 * have done had its delivery not been lost.
 *
 * WHY A SWEEP. The hook is fire-and-forget — a failed soft delete is logged and
 * nothing retries it — so a CMS product deleted (and, typically, re-created under a
 * NEW id with the same name and sku) could leave its old commerce row live for good:
 * listed in Pricing & inventory beside the new one, and still holding the sku the
 * new product needs.
 *
 * WHY SO MANY GATES. The tombstone is final and releases the sku, and on EmDash's
 * SANDBOX bridge a failed CMS read answers `null` — exactly like a deletion. So this
 * suite pins, against a real SQLite document store and the host's `ctx.content` as
 * EmDash answers it on both paths (`fakeCms`, `trusted` and `bridge`):
 *  - three strikes a cadence apart, each three misses in a row, each from a run
 *    that found some OTHER document (the page's, or a canary's): a found document
 *    wipes the strikes, and only the third strike tombstones;
 *  - a CMS that cannot be seen (an empty or failed list, a canary read `null`) marks
 *    and deletes nothing and wipes every strike; a FLAKY run (a miss a re-read
 *    overturns) strikes nothing, wipes the strikes of the rows it read and moves on;
 *  - a dense block of real orphans (every read truthful) is struck out like any rows;
 *  - seeded simulations of INTERMITTENT `null`s (the bridge swallowing sporadic D1
 *    errors, `get` alone or with `list`, steady or bursty, p up to 0.9) tombstone no
 *    live product — seeded PRNGs and one independent-failure model, not a proof;
 *  - a strike lives for at least seven days, or four full passes if longer;
 *  - a read that rejects never counts as gone, and one row rejecting run after run
 *    is stepped past (left live) rather than stopping the walk forever;
 *  - at most `ORPHAN_TOMBSTONES_PER_TICK` tombstones a tick;
 *  - the soft delete is the hook's own: a replay is a no-op, holds, stock and
 *    orders are untouched, and the delete-and-recreate shape frees the sku;
 *  - the walk pages behind a compound `(createdAt, id)` cursor across ticks on the
 *    Workers Free budget, never steps over equal timestamps, keeps its place when a
 *    delete or the tick's ceiling interrupts it, and a full pass ends.
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	uuidIdGen,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepCursorStore,
} from "../src/cron/index.js";
import {
	AGING_TICKS,
	ORPHAN_MAX_READ_FAILURES,
	ORPHAN_STRIKES,
	ORPHAN_TOMBSTONES_PER_TICK,
	PRODUCT_ORPHAN_GRACE_MS,
	STARVING_TICKS,
	starvingLeg,
	tickOrder,
} from "../src/cron/sweeps.js";
import {
	DAY_MS,
	fakeCms,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	placeOrder,
	seededRandom,
	sweepContext,
	type CallCounter,
	type FakeCms,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
/** Comfortably outside the grace window. */
const CREATED = new Date(NOW.getTime() - 2 * HOUR_MS);
/** Far enough on for the next run to be a separate, independent look. */
const CADENCE = 16 * MINUTE_MS;
/** The offsets of the runs that strike a row out: 0, one cadence, two. */
const STRIKE_RUNS = Array.from({ length: ORPHAN_STRIKES }, (_, i) => i * CADENCE);
const FREE = 30;
const PAID = 600;

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

/** A priced commerce row for `id`, written by the store itself at `at`. */
async function product(id: string, at: Date = CREATED, sku = `SKU-${id}`): Promise<void> {
	await new EmdashProductCommerceStore({ storage, clock: new FixedClock(at) }).upsert(
		{
			productId: toProductId(id),
			sku: toSku(sku),
			price: money(cents(1500), currency("USD")),
			title: `Product ${id}`,
		},
		idempotencyKey(`seed-${id}`),
	);
}

async function row(id: string): Promise<ProductCommerceDoc | null> {
	return await collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION).get(id);
}

async function lifecycleOf(id: string): Promise<string | undefined> {
	return (await row(id))?.lifecycle;
}

/** One tick at `offsetMs` after NOW, with the CMS `cms` behind `ctx.content`. */
async function tick(
	cms: FakeCms | undefined,
	cursors: SweepCursorStore,
	offsetMs = 0,
	over: Partial<CommerceSweepOptions> & { counter?: CallCounter; store?: StorageAccess } = {},
): Promise<CommerceSweepSummary> {
	const { counter, store, ...options } = over;
	const ctx = sweepContext(store ?? storage, counter, { [BACKGROUND_WORK_KEY]: PAID }, cms);
	return await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
		cursors,
		now: new Date(NOW.getTime() + offsetMs),
		...options,
	});
}

function orphanLeg(summary: CommerceSweepSummary) {
	const found = summary.legs.find((entry) => entry.leg === "product-orphans");
	if (found === undefined) throw new Error("no product-orphans leg in the summary");
	return found;
}

/** The leg's kv document: cursor, suspects (strikes), failure streaks. */
async function orphanState(cursors: SweepCursorStore): Promise<{
	suspects: Record<string, { n: number; at: string }>;
	failures: Record<string, { n: number; at: string }>;
}> {
	const raw = await cursors.read("product-orphans");
	return raw === null || raw === ""
		? { suspects: {}, failures: {} }
		: (JSON.parse(raw) as {
				suspects: Record<string, { n: number; at: string }>;
				failures: Record<string, { n: number; at: string }>;
			});
}

function strikesOf(state: Awaited<ReturnType<typeof orphanState>>): Record<string, number> {
	return Object.fromEntries(Object.entries(state.suspects).map(([id, mark]) => [id, mark.n]));
}

/** The product ids read, in order, without the canary and without re-reads. */
function rowsRead(cms: FakeCms): string[] {
	return cms.reads.filter((id, i) => id !== "listed" && cms.reads[i - 1] !== id);
}

/** Run the strike-out runs, `offset` on from NOW. Returns the summed tombstones. */
async function strikeOut(cms: FakeCms, cursors: SweepCursorStore, offset = 0): Promise<number> {
	let count = 0;
	for (const at of STRIKE_RUNS) count += orphanLeg(await tick(cms, cursors, offset + at)).count;
	return count;
}

describe("three strikes, a cadence apart", () => {
	test("a missing document is struck once a run — three misses in a row each time — and tombstoned on the third strike; published, draft and scheduled documents keep their rows", async () => {
		for (const id of ["p-gone", "p-published", "p-draft", "p-scheduled"]) await product(id);
		const cms = fakeCms({
			gone: ["p-gone"],
			status: { "p-draft": "draft", "p-scheduled": "scheduled" },
		});
		const cursors = memoryCursors();

		const first = await tick(cms, cursors);
		expect(orphanLeg(first)).toMatchObject({ ok: true, count: 0 });
		// Three looks at the missing row, one at each found one.
		expect(cms.reads.filter((id) => id === "p-gone")).toHaveLength(3);
		expect(cms.reads.filter((id) => id === "p-published")).toHaveLength(1);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-gone": 1 });

		const second = await tick(cms, cursors, CADENCE);
		expect(orphanLeg(second).count).toBe(0);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-gone": 2 });
		expect(await lifecycleOf("p-gone")).toBe("live");

		const third = await tick(cms, cursors, 2 * CADENCE);
		expect(orphanLeg(third)).toMatchObject({ ok: true, count: 1 });
		const gone = await row("p-gone");
		expect(gone).toMatchObject({ lifecycle: "deleted", active: false });
		expect(gone?.deletedAt).not.toBeNull();
		// The tombstone keeps its commercial data — order history reads it.
		expect(gone).toMatchObject({ sku: "SKU-p-gone", price: { amount: 1500, currency: "USD" } });
		for (const id of ["p-published", "p-draft", "p-scheduled"]) {
			expect(await row(id), id).toMatchObject({ lifecycle: "live", deletedAt: null });
		}
		expect((await orphanState(cursors)).suspects).toEqual({});
	});

	test("a transient null and then a found document: never tombstoned — the strikes are wiped, and a later miss starts over at one", async () => {
		await product("p-blip");
		const cms = fakeCms({ gone: ["p-blip"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-blip": 2 });

		cms.gone.clear();
		await tick(cms, cursors, 2 * CADENCE);
		expect((await orphanState(cursors)).suspects).toEqual({});

		cms.gone.add("p-blip");
		const again = await tick(cms, cursors, 3 * CADENCE);
		expect(orphanLeg(again).count).toBe(0);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-blip": 1 });
		expect(await lifecycleOf("p-blip")).toBe("live");
	});

	test("one miss among a strike's three reads is no strike: a re-read that finds the document clears it", async () => {
		await product("p-flicker");
		const cms = fakeCms();
		let looks = 0;
		cms.beforeGet = (id) => {
			if (id !== "p-flicker") return;
			looks++;
			// Missing on the first look of each run only.
			if (looks % 2 === 1) cms.gone.add(id);
			else cms.gone.delete(id);
		};
		const cursors = memoryCursors();
		for (const at of [...STRIKE_RUNS, 3 * CADENCE]) await tick(cms, cursors, at);
		expect(await lifecycleOf("p-flicker")).toBe("live");
		expect((await orphanState(cursors)).suspects).toEqual({});
	});

	test("runs inside one cadence are one look, not several: only runs a cadence apart strike", async () => {
		await product("p-soon");
		const cms = fakeCms({ gone: ["p-soon"] });
		const cursors = memoryCursors();
		for (const at of [0, 5, 10].map((m) => m * MINUTE_MS)) {
			// Forget the cadence stamp so the scan runs again minutes on.
			await cursors.write("state", "{}");
			await tick(cms, cursors, at);
		}
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-soon": 1 });
		expect(await lifecycleOf("p-soon")).toBe("live");

		await strikeOut(cms, cursors, CADENCE);
		expect(await lifecycleOf("p-soon")).toBe("deleted");
	});

	test("a page of nothing but a missing row counts only after the canary: the listed document read successfully is the other document found", async () => {
		await product("p-alone");
		const cms = fakeCms({ gone: ["p-alone"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		expect(cms.reads).toContain("listed");
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-alone": 1 });
		await tick(cms, cursors, CADENCE);
		await tick(cms, cursors, 2 * CADENCE);
		expect(await lifecycleOf("p-alone")).toBe("deleted");
	});

	for (const rowsOnPage of [1, 2, 3]) {
		test(`a single orphan among ${String(rowsOnPage)} row(s) on the Workers Free budget is struck out, and nothing else is touched`, async () => {
			const ids = Array.from({ length: rowsOnPage }, (_, i) => `p-f${String(i)}`);
			for (const [i, id] of ids.entries())
				await product(id, new Date(CREATED.getTime() + i * 1000));
			const orphan = ids.at(-1) as string;
			const cms = fakeCms({ mode: "bridge", gone: [orphan] });
			const cursors = memoryCursors();
			let doneAt: number | null = null;
			for (let t = 0; t < 120 && doneAt === null; t++) {
				const leg = orphanLeg(await tick(cms, cursors, t * MINUTE_MS, { queryBudget: FREE }));
				expect(leg.anomalies ?? [], `tick ${String(t)}`).toEqual([]);
				if ((await lifecycleOf(orphan)) === "deleted") doneAt = t;
			}
			expect(doneAt, "the orphan was never struck out").not.toBeNull();
			for (const id of ids.slice(0, -1)) expect(await lifecycleOf(id), id).toBe("live");
		});
	}

	test("a row younger than the grace window is not read, and is judged once it is older", async () => {
		await product("p-young", new Date(NOW.getTime() - PRODUCT_ORPHAN_GRACE_MS + MINUTE_MS));
		const cms = fakeCms({ gone: ["p-young"] });
		const cursors = memoryCursors();

		await tick(cms, cursors);
		expect(rowsRead(cms)).toEqual([]);
		await strikeOut(cms, cursors, CADENCE);
		expect(await lifecycleOf("p-young")).toBe("deleted");
	});
});

describe("a CMS that cannot be seen judges nothing, and wipes every strike", () => {
	for (const mode of ["bridge", "trusted"] as const) {
		test(`a total CMS outage (${mode} path) marks and deletes nothing, run after run`, async () => {
			for (const id of ["p-a", "p-b", "p-c", "p-d"]) await product(id);
			const cms = fakeCms({ mode });
			cms.outage = true;
			const cursors = memoryCursors();
			for (let run = 0; run < 4; run++) {
				const leg = orphanLeg(await tick(cms, cursors, run * CADENCE));
				expect(leg).toMatchObject({ ok: true, count: 0 });
				expect(leg.anomalies?.join("\n")).toMatch(/lists no products/);
			}
			expect((await orphanState(cursors)).suspects).toEqual({});
			for (const id of ["p-a", "p-b", "p-c", "p-d"]) expect(await lifecycleOf(id), id).toBe("live");
			// Not one row was even read: the breaker runs before the page.
			expect(cms.reads).toEqual([]);
			expect(errors.some((line) => line.includes("lists no products"))).toBe(true);
		});
	}

	test("the circuit breaker tripping wipes the strikes gathered before it", async () => {
		await product("p-struck");
		await product("p-ok", new Date(CREATED.getTime() + 1000));
		const cms = fakeCms({ mode: "bridge", gone: ["p-struck"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-struck": 2 });

		cms.listEmpty = true;
		const tripped = orphanLeg(await tick(cms, cursors, 2 * CADENCE));
		expect(tripped.anomalies?.join("\n")).toMatch(/1 suspect\(s\) cleared/);
		expect((await orphanState(cursors)).suspects).toEqual({});

		// Back to one: three more qualifying strikes are needed.
		cms.listEmpty = false;
		await tick(cms, cursors, 3 * CADENCE);
		expect(await lifecycleOf("p-struck")).toBe("live");
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-struck": 1 });
	});

	test("a canary read missing — the CMS listed a product and then could not read it — trips the breaker: nothing judged, strikes wiped", async () => {
		await product("p-only");
		const cms = fakeCms({ mode: "bridge", gone: ["p-only"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-only": 1 });

		cms.gone.add("listed");
		const tripped = orphanLeg(await tick(cms, cursors, CADENCE));
		expect(tripped).toMatchObject({ ok: true, count: 0 });
		expect(tripped.anomalies?.join("\n")).toMatch(
			/listed product listed and then read it as missing/,
		);
		expect((await orphanState(cursors)).suspects).toEqual({});
		expect(await lifecycleOf("p-only")).toBe("live");
	});

	test("a canary read that REJECTS is said, not swallowed: no miss judged, no strike, an anomaly line", async () => {
		await product("p-lonely");
		const cms = fakeCms({ gone: ["p-lonely"], failing: ["listed"] });
		const cursors = memoryCursors();
		const leg = orphanLeg(await tick(cms, cursors));
		expect(leg.ok).toBe(true);
		expect(leg.anomalies?.join("\n")).toMatch(/canary read of listed product listed failed/);
		expect(
			errors.some((line) => line.includes("canary read of listed product listed failed")),
		).toBe(true);
		expect((await orphanState(cursors)).suspects).toEqual({});
		expect(await lifecycleOf("p-lonely")).toBe("live");
	});

	test("a renamed or emptied collection — the bridge's empty list while every get says null — marks nothing", async () => {
		await product("p-x");
		const cms = fakeCms({ mode: "bridge", gone: ["p-x"] });
		cms.listEmpty = true;
		const cursors = memoryCursors();
		for (const at of [...STRIKE_RUNS, 3 * CADENCE]) await tick(cms, cursors, at);
		expect(await lifecycleOf("p-x")).toBe("live");
		expect((await orphanState(cursors)).suspects).toEqual({});
	});

	test("a FLAKY run — a row missed and then found on a re-read — strikes nothing, wipes the strikes of the rows it read, and moves past them", async () => {
		const ids = ["p-fk0", "p-fk1", "p-fk2"];
		for (const [i, id] of ids.entries()) await product(id, new Date(CREATED.getTime() + i * 1000));
		const cms = fakeCms({ mode: "bridge", gone: ["p-fk0"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-fk0": 1 });

		// p-fk2 flickers: missing on its first look, found on the re-read.
		let looks = 0;
		cms.beforeGet = (id) => {
			if (id !== "p-fk2") return;
			looks++;
			if (looks === 1) cms.gone.add(id);
			else cms.gone.delete(id);
		};
		cms.reads.length = 0;
		const flaky = orphanLeg(await tick(cms, cursors, CADENCE));
		expect(flaky).toMatchObject({ ok: true, count: 0 });
		expect(flaky.anomalies?.join("\n")).toMatch(
			/1 of 3 products read on this page were missing and then found on a re-read/,
		);
		// p-fk0's strike is wiped, not raised to two, and nothing was tombstoned.
		expect((await orphanState(cursors)).suspects).toEqual({});
		for (const id of ids) expect(await lifecycleOf(id), id).toBe("live");
	});

	test("a flaky run wipes only the strikes of rows it READ: an orphan struck on another page keeps its strikes", async () => {
		const ids = Array.from({ length: 6 }, (_, i) => `p-pg${String(i)}`);
		for (const [i, id] of ids.entries()) await product(id, new Date(CREATED.getTime() + i * 1000));
		const cms = fakeCms({ mode: "bridge", gone: ["p-pg0"] });
		const cursors = memoryCursors();
		await tick(cms, cursors, 0, { pageSize: 3 });
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-pg0": 1 });

		// The second page (p-pg3..5) flickers once; the first page's orphan is not on it.
		const flicker = { done: false };
		cms.beforeGet = (id) => {
			if (id !== "p-pg4" || flicker.done) return;
			flicker.done = true;
			cms.gone.add(id);
			cms.beforeGet = (again) => {
				if (again === "p-pg4") cms.gone.delete(again);
			};
		};
		// Tick on until the flicker has been read (the walk rests between passes).
		for (let t = 0; t < 40 && !flicker.done; t++) {
			await tick(cms, cursors, CADENCE + t * MINUTE_MS, { pageSize: 3 });
		}
		expect(flicker.done).toBe(true);
		const state = await orphanState(cursors);
		expect(strikesOf(state)["p-pg0"]).toBe(2);
		expect(errors.some((line) => line.includes("missing and then found on a re-read"))).toBe(true);
	});
});

describe("a dense block of real orphans is struck out like any rows", () => {
	/** Tick until every id in `gone` is tombstoned; the tick each finished, or null. */
	async function sweepUntilGone(gone: readonly string[], budget: number, maxTicks: number) {
		const cms = fakeCms({ gone });
		const cursors = memoryCursors();
		let doneAt: number | null = null;
		for (let t = 0; t < maxTicks && doneAt === null; t++) {
			const leg = orphanLeg(await tick(cms, cursors, t * MINUTE_MS, { queryBudget: budget }));
			expect(leg.ok, `tick ${String(t)}: ${leg.error ?? ""}`).toBe(true);
			const states = await Promise.all(gone.map((id) => lifecycleOf(id)));
			if (states.every((state) => state === "deleted")) doneAt = t;
		}
		return doneAt;
	}

	// The tick at which the last orphan of each probe was tombstoned — measured 123
	// and 379 on Free, 34 and 41 on Paid — pinned with a little room. Every read
	// truthful; the per-tick cap (five) paces the block.
	const DENSE_DONE_BY: Record<string, number> = {
		"60@30": 135,
		"60@600": 40,
		"250@30": 420,
		"250@600": 50,
	};

	for (const budget of [FREE, PAID]) {
		test(`60 rows, 20 adjacent orphans at rows 10-29 and a lone one at 50 (budget ${String(budget)}): all 21 tombstoned, nothing else`, async () => {
			const ids = Array.from({ length: 60 }, (_, i) => `p-c-${String(i).padStart(2, "0")}`);
			for (const [i, id] of ids.entries())
				await product(id, new Date(CREATED.getTime() + i * 1000));
			const gone = [...ids.slice(10, 30), ids[50] as string];
			const doneAt = await sweepUntilGone(gone, budget, 480);
			expect(doneAt, "not every orphan was tombstoned").not.toBeNull();
			expect(doneAt!).toBeLessThanOrEqual(DENSE_DONE_BY[`60@${String(budget)}`]!);
			for (const id of ids) {
				if (!gone.includes(id)) expect(await lifecycleOf(id), id).toBe("live");
			}
		});

		test(`250 rows, lone orphans at 5 and 240 and a block at 150-189 (budget ${String(budget)}): all 42 tombstoned, nothing else`, async () => {
			const ids = Array.from({ length: 250 }, (_, i) => `p-l-${String(i).padStart(3, "0")}`);
			for (const [i, id] of ids.entries())
				await product(id, new Date(CREATED.getTime() + i * 1000));
			const gone = [ids[5] as string, ...ids.slice(150, 190), ids[240] as string];
			const doneAt = await sweepUntilGone(gone, budget, 600);
			expect(doneAt, "not every orphan was tombstoned").not.toBeNull();
			expect(doneAt!).toBeLessThanOrEqual(DENSE_DONE_BY[`250@${String(budget)}`]!);
			for (const id of ids) {
				if (!gone.includes(id)) expect(await lifecycleOf(id), id).toBe("live");
			}
		}, 120_000);
	}
});

describe("a strike's lifetime follows the pass length", () => {
	async function seedStruckTwice(lastPassMs: number | null): Promise<SweepCursorStore> {
		await product("p-slow");
		const cursors = memoryCursors();
		await cursors.write(
			"product-orphans",
			JSON.stringify({
				at: null,
				id: null,
				suspects: { "p-slow": { n: 2, at: new Date(NOW.getTime() - 8 * DAY_MS).toISOString() } },
				failures: {},
				passStartedAt: null,
				lastPassMs,
			}),
		);
		return cursors;
	}

	test("seven days by default: a strike eight days old has expired, so the run strikes ONE", async () => {
		const cursors = await seedStruckTwice(null);
		await tick(fakeCms({ gone: ["p-slow"] }), cursors);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-slow": 1 });
		expect(await lifecycleOf("p-slow")).toBe("live");
	});

	test("on a catalog whose last pass took three days, the lifetime is four passes: the eight-day-old strike survives and this is strike three", async () => {
		const cursors = await seedStruckTwice(3 * DAY_MS);
		await tick(fakeCms({ gone: ["p-slow"] }), cursors);
		expect(await lifecycleOf("p-slow")).toBe("deleted");
	});

	test("a full pass records its duration", async () => {
		await product("p-pass");
		const cursors = memoryCursors();
		await tick(fakeCms(), cursors);
		const raw = JSON.parse((await cursors.read("product-orphans")) ?? "{}") as {
			lastPassMs?: number;
			passStartedAt?: string | null;
		};
		expect(raw.lastPassMs).toBe(0);
		expect(raw.passStartedAt).toBeNull();
	});
});

describe("a read that fails never counts as gone", () => {
	test("a rejected read leaves its row and every row after it live, fails loudly, and the next run resumes from it", async () => {
		await product("p-before", new Date(CREATED.getTime() - MINUTE_MS));
		await product("p-flaky");
		await product("p-after", new Date(CREATED.getTime() + MINUTE_MS));
		const cms = fakeCms({ gone: ["p-before", "p-flaky", "p-after"], failing: ["p-flaky"] });
		const cursors = memoryCursors();

		const failed = await tick(cms, cursors);
		expect(orphanLeg(failed)).toMatchObject({ ok: false });
		expect(orphanLeg(failed).error).toMatch(/p-flaky/);
		expect(errors.some((line) => line.includes("product-orphans FAILED"))).toBe(true);
		const state = await orphanState(cursors);
		expect(strikesOf(state)).toEqual({ "p-before": 1 });
		expect(Object.fromEntries(Object.entries(state.failures).map(([id, m]) => [id, m.n]))).toEqual({
			"p-flaky": 1,
		});

		cms.failing.clear();
		cms.reads.length = 0;
		await tick(cms, cursors, CADENCE);
		// Resumed at the row it stopped on — not from the top.
		expect(rowsRead(cms).slice(0, 2)).toEqual(["p-flaky", "p-after"]);
		expect((await orphanState(cursors)).failures).toEqual({});
	});

	test(`the same row rejecting on ${String(ORPHAN_MAX_READ_FAILURES)} runs in a row is stepped past — left live, logged every time — and the walk goes on`, async () => {
		await product("p-corrupt");
		await product("p-next", new Date(CREATED.getTime() + MINUTE_MS));
		const cms = fakeCms({ gone: ["p-corrupt", "p-next"], failing: ["p-corrupt"] });
		const cursors = memoryCursors();

		for (let run = 0; run < ORPHAN_MAX_READ_FAILURES - 1; run++) {
			const summary = await tick(cms, cursors, run * CADENCE);
			expect(orphanLeg(summary).ok).toBe(false);
			expect((await orphanState(cursors)).suspects).toEqual({});
		}
		const stepped = await tick(cms, cursors, (ORPHAN_MAX_READ_FAILURES - 1) * CADENCE);
		expect(orphanLeg(stepped)).toMatchObject({ ok: true });
		expect(orphanLeg(stepped).anomalies?.join("\n")).toMatch(/p-corrupt.*stepped past/);
		expect(errors.some((line) => line.includes("stepped past"))).toBe(true);
		expect(await lifecycleOf("p-corrupt")).toBe("live");
		// The row after it was reached and judged (strike one, via the canary).
		const state = await orphanState(cursors);
		expect(strikesOf(state)).toEqual({ "p-next": 1 });
		expect(state.failures).toEqual({});
	});

	test("read-failure streaks expire like strikes do: a stale one is forgotten", async () => {
		await product("p-once");
		const cms = fakeCms({ failing: ["p-once"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		expect(Object.keys((await orphanState(cursors)).failures)).toEqual(["p-once"]);
		cms.failing.clear();
		// Eight days on, with the row now readable elsewhere in the walk — the streak
		// is dropped on read, never carried.
		await product("p-later", new Date(NOW.getTime() + 7 * DAY_MS));
		cms.failing.add("p-once");
		await tick(cms, cursors, 8 * DAY_MS);
		const failures = (await orphanState(cursors)).failures;
		expect(failures["p-once"]?.n).toBe(1);
	});
});

describe("the soft delete is the hook's own, and touches nothing else", () => {
	test("replay: a later pass changes nothing — the tombstone keeps its first deletedAt, and a tombstoned row is not read again", async () => {
		await product("p-replay");
		await product("p-kept");
		const cms = fakeCms({ gone: ["p-replay"] });
		const cursors = memoryCursors();

		expect(await strikeOut(cms, cursors)).toBe(1);
		const tombstone = await row("p-replay");
		expect(tombstone?.lifecycle).toBe("deleted");

		cms.reads.length = 0;
		const later = await tick(cms, cursors, 3 * CADENCE);
		expect(orphanLeg(later)).toMatchObject({ ok: true, count: 0 });
		expect(rowsRead(cms)).toEqual(["p-kept"]);
		expect(await row("p-replay")).toEqual(tombstone);

		// The hook's own delivery, arriving late, is the same no-op: the sweep wrote
		// under the hook's idempotency key.
		await new EmdashProductCommerceStore({ storage, clock: new FixedClock(NOW) }).softDelete(
			toProductId("p-replay"),
			idempotencyKey("products:p-replay:deleted"),
		);
		expect(await row("p-replay")).toEqual(tombstone);
	});

	test("a deleted product's stock and its order's hold stay exactly where they were, and the order's snapshot is not touched", async () => {
		const placed = await placeOrder(
			storage,
			"orphan-hold",
			new Date(NOW.getTime() + DAY_MS),
			CREATED,
		);
		await product("prod-orphan-hold", CREATED, placed.sku);
		const orders = collectionOf<Record<string, unknown>>(storage, ORDERS_COLLECTION);
		const orderBefore = await orders.get(placed.id);
		const inventory = new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(NOW),
		});
		const onHandBefore = await inventory.getOnHand(toSku(placed.sku));

		await strikeOut(fakeCms({ gone: ["prod-orphan-hold"] }), memoryCursors());

		expect(await lifecycleOf("prod-orphan-hold")).toBe("deleted");
		expect(await inventory.getOnHand(toSku(placed.sku))).toBe(onHandBefore);
		// The same ticks' `hold-intents` leg finishes the order's own hold adoption —
		// its work, not this leg's — so the snapshot is what is compared.
		const orderAfter = await orders.get(placed.id);
		for (const field of ["items", "totals", "state", "currency"] as const) {
			expect(orderAfter?.[field], field).toEqual(orderBefore?.[field]);
		}
		expect(orderAfter?.["orderId"]).toBe(toOrderId(placed.id));
		expect(orderAfter?.["holdsReleased"]).toBeNull();
	});

	test("delete-and-recreate (new id): the old row is soft-deleted, the new row stays live, and the sku is free for the new product", async () => {
		await product("p-mug-old", CREATED, "SKU-MUG");
		await new EmdashProductCommerceStore({ storage, clock: new FixedClock(CREATED) }).upsert(
			{ productId: toProductId("p-mug-new"), title: "Mug" },
			idempotencyKey("sync-p-mug-new"),
		);
		const store = new EmdashProductCommerceStore({ storage, clock: new FixedClock(NOW) });
		await expect(
			store.upsert(
				{ productId: toProductId("p-mug-new"), sku: toSku("SKU-MUG") },
				idempotencyKey("price-1"),
			),
		).rejects.toMatchObject({ name: "SkuConflictError" });

		await strikeOut(fakeCms({ gone: ["p-mug-old"] }), memoryCursors());

		expect(await row("p-mug-old")).toMatchObject({ lifecycle: "deleted", sku: "SKU-MUG" });
		expect(await row("p-mug-new")).toMatchObject({ lifecycle: "live", deletedAt: null });
		const priced = await store.upsert(
			{ productId: toProductId("p-mug-new"), sku: toSku("SKU-MUG") },
			idempotencyKey("price-2"),
		);
		expect(priced.sku).toBe("SKU-MUG");
	});

	test(`at most ${String(ORPHAN_TOMBSTONES_PER_TICK)} tombstones a tick — second pass included — logged when the cap is hit; the rest go on the next tick`, async () => {
		const gone = Array.from({ length: 7 }, (_, i) => `p-cap-g${String(i)}`);
		// Enough found rows that seven misses stay under the first-look breaker's 30%.
		const kept = Array.from({ length: 20 }, (_, i) => `p-cap-k${String(i)}`);
		for (const [i, id] of [...gone, ...kept].entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const cms = fakeCms({ gone });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);
		const capped = await tick(cms, cursors, 2 * CADENCE);
		expect(orphanLeg(capped).count).toBe(ORPHAN_TOMBSTONES_PER_TICK);
		expect(orphanLeg(capped).incomplete).toBe(true);
		expect(errors.some((line) => line.includes("cap of 5 tombstones"))).toBe(true);

		const rest = await tick(cms, cursors, 2 * CADENCE + MINUTE_MS);
		expect(orphanLeg(rest).count).toBe(gone.length - ORPHAN_TOMBSTONES_PER_TICK);
		for (const id of gone) expect(await lifecycleOf(id), id).toBe("deleted");
		for (const id of kept) expect(await lifecycleOf(id), id).toBe("live");
	});
});

describe("the cursor keeps its place", () => {
	test("a delete that throws keeps the rows already handled, fails the leg, and the next run resumes at that row", async () => {
		for (const [i, id] of ["p-t0", "p-t1", "p-t2"].entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const cms = fakeCms({ gone: ["p-t0", "p-t1", "p-t2"].slice(0, 2) });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);
		// A store whose write of p-t1 fails, for this run only.
		const broken: StorageAccess = { ...storage };
		const collection = storage[PRODUCT_COMMERCE_COLLECTION]!;
		broken[PRODUCT_COMMERCE_COLLECTION] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (prop !== "compareAndSet" || typeof value !== "function") {
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (id: string, ...rest: unknown[]) => {
					if (id === "p-t1") throw new Error("D1_ERROR: write failed");
					return (value as (...a: unknown[]) => unknown).apply(target, [id, ...rest]);
				};
			},
		});
		const failed = await tick(cms, cursors, 2 * CADENCE, { store: broken });
		expect(orphanLeg(failed)).toMatchObject({ ok: false });
		expect(orphanLeg(failed).error).toMatch(/write failed/);
		expect(await lifecycleOf("p-t0")).toBe("deleted");
		expect(await lifecycleOf("p-t1")).toBe("live");

		cms.reads.length = 0;
		const resumed = await tick(cms, cursors, 3 * CADENCE);
		expect(rowsRead(cms)[0]).toBe("p-t1");
		expect(orphanLeg(resumed).count).toBe(1);
		expect(await lifecycleOf("p-t1")).toBe("deleted");
	});

	test("the tick's ceiling refusing a read keeps the place: the leg is incomplete, not failed, and the next tick resumes at that row", async () => {
		for (const [i, id] of ["p-c0", "p-c1", "p-c2"].entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const cms = fakeCms();
		cms.beforeGet = (id) => {
			if (id !== "p-c1") return;
			const refusal = Object.assign(new Error("the sweep tick reached its ceiling"), {
				name: "SweepQueryCeilingError",
				ceiling: 29,
				leg: "product-orphans",
			});
			throw refusal;
		};
		const cursors = memoryCursors();
		const refused = await tick(cms, cursors);
		expect(orphanLeg(refused)).toMatchObject({ ok: true, incomplete: true });

		cms.beforeGet = undefined;
		cms.reads.length = 0;
		await tick(cms, cursors, MINUTE_MS);
		expect(cms.reads).toEqual(["p-c1", "p-c2"]);
	});

	test("rows sharing one createdAt are all judged across page and tick boundaries — none stepped over", async () => {
		const ids = ["p-tie-a", "p-tie-b", "p-tie-c", "p-tie-d", "p-tie-e"];
		for (const id of ids) await product(id, CREATED);
		const cms = fakeCms();
		const cursors = memoryCursors();
		for (let t = 0; t < 10; t++) {
			const summary = await tick(cms, cursors, t * MINUTE_MS, { pageSize: 2 });
			if (orphanLeg(summary).incomplete !== true) break;
		}
		expect(cms.reads.toSorted()).toEqual(ids);
	});
});

describe("the walk fits the budget and pages across ticks", () => {
	test("on the Workers Free budget, a 40-product catalog: no tick over budget, every orphan struck out over three passes, nothing live touched", async () => {
		const ids = Array.from({ length: 40 }, (_, i) => `p-cat-${String(i).padStart(2, "0")}`);
		for (const [i, id] of ids.entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const gone = ids.filter((_, i) => i % 10 === 2);
		const cms = fakeCms({ gone });
		const cursors = memoryCursors();
		const counter: CallCounter = { calls: 0 };
		let firstPass: number | null = null;
		let doneAt: number | null = null;
		for (let t = 0; t < 180 && doneAt === null; t++) {
			counter.calls = 0;
			const summary = await tick(cms, cursors, t * MINUTE_MS, { counter, queryBudget: FREE });
			// Never over the budget, counted from outside the sweep.
			expect(counter.calls, `tick ${String(t)}`).toBeLessThanOrEqual(FREE);
			const leg = orphanLeg(summary);
			expect(leg.ok, `tick ${String(t)}: ${leg.error ?? ""}`).toBe(true);
			if (leg.notDue === true && firstPass === null) firstPass = t;
			const done = await Promise.all(gone.map(async (id) => (await lifecycleOf(id)) === "deleted"));
			if (done.every(Boolean)) doneAt = t;
		}
		for (const id of ids) {
			expect(await lifecycleOf(id), id).toBe(gone.includes(id) ? "deleted" : "live");
		}
		// Measured: the first pass ends in 18 ticks; the orphans go on the third
		// pass, each pass a maintenance interval after the last finished. A
		// 1000-product catalog measured one pass in about 350 ticks on Workers Free
		// (about six hours; 7 ticks on Paid), and an orphan in it went after about 900
		// ticks: three passes, up to about eighteen hours.
		expect(firstPass, "the first pass never ended").not.toBeNull();
		expect(firstPass!).toBeLessThanOrEqual(20);
		expect(doneAt, "the orphans were never struck out").not.toBeNull();
		expect(doneAt!).toBeLessThanOrEqual(90);
	});
});

/** Reviewer B's PRNG (a 32-bit LCG), so the adversarial cases replay exactly. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 4294967296;
	};
}

/**
 * THE INTERMITTENT-FAILURE SIMULATIONS (review rounds 2-5). The sandbox bridge answers
 * `null` for any D1 error, so a database failing some reads at random looks like
 * products disappearing at random. Every case is deterministic (a seeded PRNG), and
 * every case must end with ZERO live products tombstoned — one seed set and one
 * independent-failure model, not a proof.
 *
 * Earlier designs, for the record: two strikes tombstoned 5 (p = 0.15) and 20-26
 * (p = 0.3) of 40; three strikes struck out up to 25 at p = 0.7 on Paid; and a
 * first-look page breaker stopped that but stalled the walk on a dense block of
 * real orphans. Contradiction (a miss a re-read overturns) is what tells them apart.
 */
describe("intermittent CMS failures never tombstone a live product (seeded)", () => {
	const matrix = [374, 12345, 777, 2026].flatMap((seed) =>
		(["get", "get+list"] as const).flatMap((failing) =>
			[FREE, PAID].flatMap((budget) =>
				[0.15, 0.3, 0.5, 0.7, 0.9].map((p) => ({ seed, failing, budget, p })),
			),
		),
	);
	test.each(matrix)(
		"40 live + 1 orphan, $failing failing, budget $budget, p = $p, seed $seed, 360 ticks: no live product tombstoned",
		async ({ seed, failing, budget, p }) => {
			const live = Array.from({ length: 40 }, (_, i) => `p-sim-${String(i).padStart(2, "0")}`);
			for (const [i, id] of live.entries())
				await product(id, new Date(CREATED.getTime() + i * 1000));
			await product("p-sim-orphan", new Date(CREATED.getTime() + 20_500));
			const cms = fakeCms({ mode: "bridge", gone: ["p-sim-orphan"] });
			cms.nullRate = p;
			if (failing === "get+list") cms.listFailRate = p;
			cms.random = seededRandom(seed);
			const cursors = memoryCursors();
			const counter: CallCounter = { calls: 0 };
			for (let t = 0; t < 360; t++) {
				counter.calls = 0;
				const leg = orphanLeg(
					await tick(cms, cursors, t * MINUTE_MS, { queryBudget: budget, counter }),
				);
				expect(leg.ok, `tick ${String(t)}: ${leg.error ?? ""}`).toBe(true);
				expect(counter.calls, `tick ${String(t)}`).toBeLessThanOrEqual(budget);
			}
			for (const id of live) expect(await lifecycleOf(id), id).toBe("live");
		},
		120_000,
	);

	// Reviewer B's adversarial cases, replayed with its own PRNG: a 250-row catalog (a
	// pass spans pages) with p straddling the old 30% threshold, and bursty failures —
	// twenty minutes at `hi`, twenty at `lo`.
	const adversarial = [12345, 777, 2026].flatMap((seed) =>
		[FREE, PAID].flatMap((budget) => [
			...[0.2, 0.25, 0.3, 0.35, 0.5, 0.9].map((p) => ({ seed, budget, hi: p, lo: p })),
			{ seed, budget, hi: 0.6, lo: 0.25 },
			{ seed, budget, hi: 0.9, lo: 0.3 },
		]),
	);
	test.each(adversarial)(
		"250 live rows, budget $budget, p $hi/$lo (twenty-minute bursts when they differ), seed $seed, 360 ticks: none tombstoned",
		async ({ seed, budget, hi, lo }) => {
			const ids = Array.from({ length: 250 }, (_, i) => `p-a-${String(i).padStart(3, "0")}`);
			for (const [i, id] of ids.entries())
				await product(id, new Date(CREATED.getTime() + i * 1000));
			const cms = fakeCms({ mode: "bridge" });
			const random = lcg(seed);
			let p = hi;
			cms.beforeGet = (id) => {
				if (random() < p) cms.failing.add(id);
				else cms.failing.delete(id);
			};
			const cursors = memoryCursors();
			for (let t = 0; t < 360; t++) {
				p = Math.floor(t / 20) % 2 === 0 ? hi : lo;
				await tick(cms, cursors, t * MINUTE_MS, { queryBudget: budget });
			}
			let falseTombstones = 0;
			for (const id of ids) if ((await lifecycleOf(id)) === "deleted") falseTombstones++;
			expect(falseTombstones).toBe(0);
		},
		300_000,
	);
});

describe("scheduling and logging", () => {
	test("never promoted: however long it waits, product-orphans does not jump the queue or the starvation guard", () => {
		const waits = { "product-orphans": STARVING_TICKS * 10 };
		expect(tickOrder(waits).at(-1)).toBe("product-orphans");
		expect(starvingLeg(waits)).toBeUndefined();
		// While an ordinary leg that waited is promoted as before.
		expect(tickOrder({ "coupon-orphans": AGING_TICKS })[0]).toBe("coupon-orphans");
	});

	test("with no ctx.content the leg reports skipped and reads nothing — and each unwired leg says so once per isolate", async () => {
		vi.resetModules();
		const fresh = await import("../src/cron/sweeps.js");
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		await product("p-unwired");
		const cursors = memoryCursors();
		for (let run = 0; run < 2; run++) {
			// The cadence stamp is forgotten, so the scan is due both times.
			await cursors.write("state", "{}");
			const summary = await fresh.runCommerceSweeps(
				sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID }),
				SWEEP_TASK_NAME,
				{ cursors, now: new Date(NOW.getTime() + run * CADENCE) },
			);
			const leg = summary.legs.find((entry) => entry.leg === "product-orphans");
			expect(leg).toMatchObject({ ok: true, count: 0, skipped: true, queries: 0 });
		}
		const said = (leg: string): number =>
			lines.filter((line) => line.includes(`${leg} skipped — not wired`)).length;
		// One line each, over two ticks — the email outbox's line no longer silences it.
		expect(said("product-orphans")).toBe(1);
		expect(said("order-emails")).toBe(1);
		expect(await lifecycleOf("p-unwired")).toBe("live");
	});
});
