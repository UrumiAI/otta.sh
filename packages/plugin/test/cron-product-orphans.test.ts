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
 *  - two strikes a cadence apart: a first `null` only marks a suspect, a found
 *    document clears it, and only a second `null` a cadence later tombstones;
 *  - a CMS that cannot be seen (an empty or failed list), and a page that is mostly
 *    missing, mark and delete nothing;
 *  - a read that rejects never counts as gone, and one row rejecting run after run
 *    is stepped past (left live) rather than stopping the walk forever;
 *  - at most `ORPHAN_TOMBSTONES_PER_TICK` tombstones a run;
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
	sweepContext,
	type CallCounter,
	type FakeCms,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
/** Comfortably outside the grace window. */
const CREATED = new Date(NOW.getTime() - 2 * HOUR_MS);
/** Far enough on for the next run to be a second, independent look. */
const CADENCE = 16 * MINUTE_MS;
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

/** The leg's kv document: cursor, suspects, failure streaks. */
async function orphanState(cursors: SweepCursorStore): Promise<{
	suspects: Record<string, string>;
	failures: Record<string, number>;
}> {
	const raw = await cursors.read("product-orphans");
	return raw === null || raw === ""
		? { suspects: {}, failures: {} }
		: (JSON.parse(raw) as { suspects: Record<string, string>; failures: Record<string, number> });
}

describe("two strikes, a cadence apart", () => {
	test("a missing document is only SUSPECT on the first run, and tombstoned by a run a cadence later; published, draft and scheduled documents keep their rows", async () => {
		for (const id of ["p-gone", "p-published", "p-draft", "p-scheduled"]) await product(id);
		const cms = fakeCms({
			gone: ["p-gone"],
			status: { "p-draft": "draft", "p-scheduled": "scheduled" },
		});
		const cursors = memoryCursors();

		const first = await tick(cms, cursors);
		expect(orphanLeg(first)).toMatchObject({ ok: true, count: 0 });
		expect(await lifecycleOf("p-gone")).toBe("live");
		expect(Object.keys((await orphanState(cursors)).suspects)).toEqual(["p-gone"]);

		const second = await tick(cms, cursors, CADENCE);
		expect(orphanLeg(second)).toMatchObject({ ok: true, count: 1 });
		const gone = await row("p-gone");
		expect(gone).toMatchObject({ lifecycle: "deleted", active: false });
		expect(gone?.deletedAt).not.toBeNull();
		// The tombstone keeps its commercial data — order history reads it.
		expect(gone).toMatchObject({ sku: "SKU-p-gone", price: { amount: 1500, currency: "USD" } });
		for (const id of ["p-published", "p-draft", "p-scheduled"]) {
			expect(await row(id), id).toMatchObject({ lifecycle: "live", deletedAt: null });
		}
		// Confirmed suspects leave the set.
		expect((await orphanState(cursors)).suspects).toEqual({});
	});

	test("a transient null and then a found document: never tombstoned — the suspicion is cleared, and a later null starts over", async () => {
		await product("p-blip");
		const cms = fakeCms({ gone: ["p-blip"] });
		const cursors = memoryCursors();

		await tick(cms, cursors);
		expect((await orphanState(cursors)).suspects).toHaveProperty("p-blip");

		cms.gone.clear();
		await tick(cms, cursors, CADENCE);
		expect((await orphanState(cursors)).suspects).toEqual({});

		// Missing again: strike ONE again, not two.
		cms.gone.add("p-blip");
		const third = await tick(cms, cursors, 2 * CADENCE);
		expect(orphanLeg(third).count).toBe(0);
		expect(await lifecycleOf("p-blip")).toBe("live");
	});

	test("two nulls inside one cadence are one look, not two: the second run, minutes later, does not tombstone", async () => {
		await product("p-soon");
		const cms = fakeCms({ gone: ["p-soon"] });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		// Forget the cadence stamp so the scan runs again ten minutes on.
		await cursors.write("state", "{}");
		const early = await tick(cms, cursors, 10 * MINUTE_MS);
		expect(orphanLeg(early).count).toBe(0);
		expect(await lifecycleOf("p-soon")).toBe("live");

		const later = await tick(cms, cursors, 10 * MINUTE_MS + CADENCE);
		expect(orphanLeg(later).count).toBe(1);
		expect(await lifecycleOf("p-soon")).toBe("deleted");
	});

	test("a row younger than the grace window is not read, and is judged once it is older", async () => {
		await product("p-young", new Date(NOW.getTime() - PRODUCT_ORPHAN_GRACE_MS + MINUTE_MS));
		const cms = fakeCms({ gone: ["p-young"] });
		const cursors = memoryCursors();

		await tick(cms, cursors);
		expect(cms.reads).toEqual([]);
		await tick(cms, cursors, CADENCE);
		await tick(cms, cursors, 2 * CADENCE);
		expect(await lifecycleOf("p-young")).toBe("deleted");
	});
});

describe("a CMS that cannot be seen judges nothing", () => {
	for (const mode of ["bridge", "trusted"] as const) {
		test(`a total CMS outage (${mode} path) marks and deletes nothing, run after run`, async () => {
			for (const id of ["p-a", "p-b", "p-c", "p-d"]) await product(id);
			const cms = fakeCms({ mode });
			cms.outage = true;
			const cursors = memoryCursors();
			for (let run = 0; run < 3; run++) {
				const summary = await tick(cms, cursors, run * CADENCE);
				const leg = orphanLeg(summary);
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

	test("a renamed or emptied collection — the bridge's empty list while every get says null — marks nothing", async () => {
		await product("p-x");
		const cms = fakeCms({ mode: "bridge", gone: ["p-x"] });
		cms.listEmpty = true;
		const cursors = memoryCursors();
		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);
		expect(await lifecycleOf("p-x")).toBe("live");
		expect((await orphanState(cursors)).suspects).toEqual({});
	});

	test("the mass-disappearance breaker: a page mostly missing is abandoned — nothing marked — while a couple missing is not", async () => {
		const ids = ["p-m0", "p-m1", "p-m2", "p-m3"];
		for (const [i, id] of ids.entries()) await product(id, new Date(CREATED.getTime() + i * 1000));
		const cms = fakeCms({ mode: "bridge", gone: ["p-m0", "p-m1", "p-m2"] });
		const cursors = memoryCursors();

		const abandoned = await tick(cms, cursors);
		expect(orphanLeg(abandoned).anomalies?.join("\n")).toMatch(/3 of 4 products/);
		expect((await orphanState(cursors)).suspects).toEqual({});
		await tick(cms, cursors, CADENCE);
		for (const id of ids) expect(await lifecycleOf(id), id).toBe("live");

		// Two of four missing: below the floor, so both are marked as usual.
		cms.gone.delete("p-m2");
		await tick(cms, cursors, 2 * CADENCE);
		expect(Object.keys((await orphanState(cursors)).suspects).toSorted()).toEqual(["p-m0", "p-m1"]);
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
		expect(Object.keys(state.suspects)).toEqual(["p-before"]);
		expect(state.failures).toEqual({ "p-flaky": 1 });

		cms.failing.clear();
		cms.reads.length = 0;
		await tick(cms, cursors, CADENCE);
		// Resumed at the row it stopped on — not from the top.
		expect(cms.reads.slice(0, 2)).toEqual(["p-flaky", "p-after"]);
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
		// The row after it was reached and judged (strike one).
		const state = await orphanState(cursors);
		expect(Object.keys(state.suspects)).toEqual(["p-next"]);
		expect(state.failures).toEqual({});
	});
});

describe("the soft delete is the hook's own, and touches nothing else", () => {
	test("replay: a later pass changes nothing — the tombstone keeps its first deletedAt, and a tombstoned row is not read again", async () => {
		await product("p-replay");
		await product("p-kept");
		const cms = fakeCms({ gone: ["p-replay"] });
		const cursors = memoryCursors();

		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);
		const tombstone = await row("p-replay");
		expect(tombstone?.lifecycle).toBe("deleted");

		cms.reads.length = 0;
		const third = await tick(cms, cursors, 2 * CADENCE);
		expect(orphanLeg(third)).toMatchObject({ ok: true, count: 0 });
		expect(cms.reads).toEqual(["p-kept"]);
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
		const cms = fakeCms({ gone: ["prod-orphan-hold"] });
		const cursors = memoryCursors();

		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);

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
		const cms = fakeCms({ gone: ["p-mug-old"] });
		const cursors = memoryCursors();

		await tick(cms, cursors);
		await tick(cms, cursors, CADENCE);

		expect(await row("p-mug-old")).toMatchObject({ lifecycle: "deleted", sku: "SKU-MUG" });
		expect(await row("p-mug-new")).toMatchObject({ lifecycle: "live", deletedAt: null });
		const priced = await store.upsert(
			{ productId: toProductId("p-mug-new"), sku: toSku("SKU-MUG") },
			idempotencyKey("price-2"),
		);
		expect(priced.sku).toBe("SKU-MUG");
	});

	test(`at most ${String(ORPHAN_TOMBSTONES_PER_TICK)} tombstones a tick — second pass included — logged when the cap is hit; the rest go on the next run`, async () => {
		const gone = Array.from({ length: 7 }, (_, i) => `p-cap-g${String(i)}`);
		const kept = Array.from({ length: 8 }, (_, i) => `p-cap-k${String(i)}`);
		for (const [i, id] of [...gone, ...kept].entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const cms = fakeCms({ gone });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		const capped = await tick(cms, cursors, CADENCE);
		expect(orphanLeg(capped).count).toBe(ORPHAN_TOMBSTONES_PER_TICK);
		expect(orphanLeg(capped).incomplete).toBe(true);
		expect(errors.some((line) => line.includes("cap of 5 tombstones"))).toBe(true);

		const rest = await tick(cms, cursors, CADENCE + MINUTE_MS);
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
		const failed = await tick(cms, cursors, CADENCE, { store: broken });
		expect(orphanLeg(failed)).toMatchObject({ ok: false });
		expect(orphanLeg(failed).error).toMatch(/write failed/);
		expect(await lifecycleOf("p-t0")).toBe("deleted");
		expect(await lifecycleOf("p-t1")).toBe("live");

		cms.reads.length = 0;
		const resumed = await tick(cms, cursors, 2 * CADENCE);
		expect(cms.reads[0]).toBe("p-t1");
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
	test("on the Workers Free budget, a 40-product catalog: every orphan is reached on the second pass, nothing live is touched, and each pass ends", async () => {
		const ids = Array.from({ length: 40 }, (_, i) => `p-cat-${String(i).padStart(2, "0")}`);
		for (const [i, id] of ids.entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const gone = ids.filter((_, i) => i % 10 === 2);
		const cms = fakeCms({ gone });
		const cursors = memoryCursors();
		const counter: CallCounter = { calls: 0 };
		let firstPass: number | null = null;
		let t = 0;
		for (; t < 60; t++) {
			counter.calls = 0;
			const summary = await tick(cms, cursors, t * MINUTE_MS, { counter, queryBudget: FREE });
			// Never over the budget, counted from outside the sweep.
			expect(counter.calls, `tick ${String(t)}`).toBeLessThanOrEqual(FREE);
			const leg = orphanLeg(summary);
			expect(leg.ok, `tick ${String(t)}: ${leg.error ?? ""}`).toBe(true);
			if (leg.notDue === true && firstPass === null) firstPass = t;
			const done = await Promise.all(gone.map(async (id) => (await lifecycleOf(id)) === "deleted"));
			if (done.every(Boolean)) break;
		}
		for (const id of ids) {
			expect(await lifecycleOf(id), id).toBe(gone.includes(id) ? "deleted" : "live");
		}
		// Measured: the first pass ends within 12 ticks — three to four rows a tick on
		// an idle Free tick (its share, then the second pass on what is left, each run
		// paying the circuit breaker's list first). A 1000-product catalog measured one
		// pass in 280 ticks — under five hours — and 7 ticks on the Paid preset. An
		// orphan is confirmed, and tombstoned, on the pass after the one that found it.
		expect(firstPass, "the first pass never ended").not.toBeNull();
		expect(firstPass!).toBeLessThanOrEqual(12);
	});
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
