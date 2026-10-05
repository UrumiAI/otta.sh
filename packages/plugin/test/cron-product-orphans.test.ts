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
 *  - a CMS that cannot be seen (an empty or failed list, a canary read `null`), and
 *    a page where too many rows miss on the first read, mark and delete nothing —
 *    and wipe every strike; the page breaker moves the walk PAST its page, so a dense
 *    block of real orphans is left for a human and never stalls the walk;
 *  - a seeded simulation of INTERMITTENT `null`s (the bridge swallowing sporadic D1
 *    errors, `get` alone or with `list`) tombstones no live product at any p up to 0.7
 *    over 360 ticks — one seed and one independent-failure model, not a proof;
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

	test("one orphan among three rows on the Workers Free budget never trips a breaker (three first-look misses are the floor) and is struck out", async () => {
		for (const [i, id] of ["p-f0", "p-f1", "p-f2"].entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const cms = fakeCms({ mode: "bridge", gone: ["p-f1"] });
		const cursors = memoryCursors();
		let doneAt: number | null = null;
		for (let t = 0; t < 120 && doneAt === null; t++) {
			const leg = orphanLeg(await tick(cms, cursors, t * MINUTE_MS, { queryBudget: FREE }));
			expect(leg.anomalies ?? [], `tick ${String(t)}`).toEqual([]);
			if ((await lifecycleOf("p-f1")) === "deleted") doneAt = t;
		}
		expect(doneAt, "the orphan was never struck out").not.toBeNull();
		for (const id of ["p-f0", "p-f2"]) expect(await lifecycleOf(id), id).toBe("live");
	});

	test("the first-look breaker: three of eight rows missing on the first read abandons the page — even though every re-read then found them", async () => {
		const ids = Array.from({ length: 8 }, (_, i) => `p-fl${String(i)}`);
		for (const [i, id] of ids.entries()) await product(id, new Date(CREATED.getTime() + i * 1000));
		const cms = fakeCms({ mode: "bridge", gone: ["p-fl0"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-fl0": 1 });

		// p-fl1 and p-fl2 flicker: missing on the first look, found on the re-read.
		const flicker = new Set(["p-fl1", "p-fl2"]);
		cms.beforeGet = (id) => {
			if (!flicker.has(id)) return;
			if (cms.gone.has(id)) cms.gone.delete(id);
			else cms.gone.add(id);
		};
		const tripped = orphanLeg(await tick(cms, cursors, CADENCE));
		expect(tripped.anomalies?.join("\n")).toMatch(
			/3 of 8 products read on this page missed on the first look/,
		);
		expect((await orphanState(cursors)).suspects).toEqual({});
		for (const id of ids) expect(await lifecycleOf(id), id).toBe("live");
	});

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

	test("the mass-disappearance breaker: a page mostly missing is abandoned — nothing marked, strikes wiped — while a couple missing is not", async () => {
		const ids = ["p-m0", "p-m1", "p-m2", "p-m3"];
		for (const [i, id] of ids.entries()) await product(id, new Date(CREATED.getTime() + i * 1000));
		const cms = fakeCms({ mode: "bridge", gone: ["p-m0"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-m0": 1 });

		cms.gone.add("p-m1");
		cms.gone.add("p-m2");
		const abandoned = orphanLeg(await tick(cms, cursors, CADENCE));
		expect(abandoned.anomalies?.join("\n")).toMatch(/3 of 4 products/);
		expect((await orphanState(cursors)).suspects).toEqual({});
		for (const at of [2, 3].map((n) => n * CADENCE)) await tick(cms, cursors, at);
		for (const id of ids) expect(await lifecycleOf(id), id).toBe("live");

		// Two of four missing: below the floor, so both are struck as usual.
		cms.gone.delete("p-m2");
		await tick(cms, cursors, 4 * CADENCE);
		expect(strikesOf(await orphanState(cursors))).toEqual({ "p-m0": 1, "p-m1": 1 });
	});
});

describe("a dense block of real orphans never stalls the walk", () => {
	test("on the Paid budget: a page tripped by a block of 40 deleted products is passed over (the block stays live, named in the log) and a lone orphan after it is still struck out", async () => {
		const ids = Array.from({ length: 120 }, (_, i) => `p-blk-${String(i).padStart(3, "0")}`);
		for (const [i, id] of ids.entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		// Rows 10-49 inside the first page (the leg's Paid share reads about 58 rows a
		// page); the lone orphan on a later one.
		const block = ids.slice(10, 50);
		const lone = ids[110] as string;
		const cms = fakeCms({ gone: [...block, lone] });
		const cursors = memoryCursors();
		let doneAt: number | null = null;
		for (let t = 0; t < 120 && doneAt === null; t++) {
			const leg = orphanLeg(await tick(cms, cursors, t * MINUTE_MS));
			expect(leg.ok, `tick ${String(t)}: ${leg.error ?? ""}`).toBe(true);
			if ((await lifecycleOf(lone)) === "deleted") doneAt = t;
		}
		expect(doneAt, "the lone orphan after the block was never struck out").not.toBeNull();
		for (const id of block) expect(await lifecycleOf(id), id).toBe("live");
		for (const id of ids) {
			if (id !== lone && !block.includes(id)) expect(await lifecycleOf(id), id).toBe("live");
		}
		expect(
			errors.some(
				(line) =>
					/40 of \d+ products read on this page missed on the first look/.test(line) &&
					/products p-blk-000 \(created [^)]+\) to p-blk-0\d\d/.test(line) &&
					line.includes("soft-delete them by hand"),
			),
		).toBe(true);
	});
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

/**
 * THE INTERMITTENT-FAILURE SIMULATION (review rounds 2 and 3). The sandbox bridge
 * answers `null` for any D1 error, so a database failing some reads at random looks
 * like products disappearing at random. Forty live products and one real orphan, for
 * 360 one-minute ticks on each preset, from a fixed seed so the run is the same every
 * time. EVERY `get` (the canary's too) fails to `null` independently with probability
 * p; in the `list fails too` variant the circuit breaker's list also comes back empty
 * with the same probability. Two strikes alone tombstoned 5 (p = 0.15) and 20-26
 * (p = 0.3) live products; three strikes without the first-look breaker still struck
 * out up to 25 at p = 0.7 on Paid.
 */
describe("intermittent CMS failures never tombstone a live product (seeded)", () => {
	// Measured with seed 374: the false tombstones each run produced, and whether the
	// real orphan was tombstoned within the 360 ticks. During sustained failures the
	// orphan WAITS — liveness drops, the safe direction — which is the `false`s here.
	const EXPECTED: Record<string, { falseTombstones: number; orphanCaught: boolean }> = {
		"get 30@0.05": { falseTombstones: 0, orphanCaught: true },
		"get 30@0.15": { falseTombstones: 0, orphanCaught: true },
		"get 30@0.3": { falseTombstones: 0, orphanCaught: false },
		"get 30@0.5": { falseTombstones: 0, orphanCaught: false },
		"get 30@0.7": { falseTombstones: 0, orphanCaught: false },
		"get 600@0.05": { falseTombstones: 0, orphanCaught: true },
		"get 600@0.15": { falseTombstones: 0, orphanCaught: true },
		"get 600@0.3": { falseTombstones: 0, orphanCaught: true },
		"get 600@0.5": { falseTombstones: 0, orphanCaught: false },
		"get 600@0.7": { falseTombstones: 0, orphanCaught: false },
		"get+list 30@0.05": { falseTombstones: 0, orphanCaught: false },
		"get+list 30@0.15": { falseTombstones: 0, orphanCaught: false },
		"get+list 30@0.3": { falseTombstones: 0, orphanCaught: false },
		"get+list 30@0.5": { falseTombstones: 0, orphanCaught: false },
		"get+list 30@0.7": { falseTombstones: 0, orphanCaught: false },
		"get+list 600@0.05": { falseTombstones: 0, orphanCaught: true },
		"get+list 600@0.15": { falseTombstones: 0, orphanCaught: true },
		"get+list 600@0.3": { falseTombstones: 0, orphanCaught: true },
		"get+list 600@0.5": { falseTombstones: 0, orphanCaught: false },
		"get+list 600@0.7": { falseTombstones: 0, orphanCaught: false },
	};
	const cases = (["get", "get+list"] as const).flatMap((failing) =>
		[FREE, PAID].flatMap((budget) =>
			[0.05, 0.15, 0.3, 0.5, 0.7].map((p) => ({ failing, budget, p })),
		),
	);
	test.each(cases)(
		"$failing failing, budget $budget, p = $p, 360 ticks",
		async ({ failing, budget, p }) => {
			const live = Array.from({ length: 40 }, (_, i) => `p-sim-${String(i).padStart(2, "0")}`);
			for (const [i, id] of live.entries()) {
				await product(id, new Date(CREATED.getTime() + i * 1000));
			}
			await product("p-sim-orphan", new Date(CREATED.getTime() + 20_500));
			const cms = fakeCms({ mode: "bridge", gone: ["p-sim-orphan"] });
			cms.nullRate = p;
			if (failing === "get+list") cms.listFailRate = p;
			cms.random = seededRandom(374);
			const cursors = memoryCursors();
			for (let t = 0; t < 360; t++) {
				const leg = orphanLeg(await tick(cms, cursors, t * MINUTE_MS, { queryBudget: budget }));
				expect(leg.ok, `tick ${String(t)}: ${leg.error ?? ""}`).toBe(true);
			}
			let falseTombstones = 0;
			for (const id of live) if ((await lifecycleOf(id)) === "deleted") falseTombstones++;
			const orphanCaught = (await lifecycleOf("p-sim-orphan")) === "deleted";
			expect({ falseTombstones, orphanCaught }).toEqual(
				EXPECTED[`${failing} ${String(budget)}@${String(p)}`],
			);
		},
		120_000,
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
