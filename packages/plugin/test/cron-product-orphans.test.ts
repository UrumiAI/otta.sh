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
 * What this suite pins, against a real SQLite document store and the host's
 * `ctx.content` read as EmDash answers it (`fakeCms`):
 *  - only a POSITIVE "not found" counts — a published, draft or scheduled document
 *    keeps its row, and a read that FAILS never counts as gone;
 *  - the soft delete is the store's own (`softDelete`, the hook's idempotency key),
 *    so a replay is a no-op, holds and stock stay where they are, and no order moves;
 *  - the delete-and-recreate shape: the old id's row goes, the new id's row stays,
 *    and the sku is free for the new product;
 *  - the walk pages behind a cursor across ticks on the Workers Free budget, and a
 *    full pass ends.
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
import { PRODUCT_ORPHAN_GRACE_MS } from "../src/cron/sweeps.js";
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

/** One tick, with the CMS `cms` behind `ctx.content`. */
async function tick(
	cms: FakeCms | undefined,
	over: Partial<CommerceSweepOptions> & { counter?: CallCounter } = {},
): Promise<CommerceSweepSummary> {
	const { counter, ...options } = over;
	const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: PAID }, cms);
	return await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
		cursors: memoryCursors(),
		now: NOW,
		...options,
	});
}

function orphanLeg(summary: CommerceSweepSummary) {
	const found = summary.legs.find((entry) => entry.leg === "product-orphans");
	if (found === undefined) throw new Error("no product-orphans leg in the summary");
	return found;
}

describe("which rows the leg judges orphaned", () => {
	test("a row whose CMS document is gone is soft-deleted; published, draft and scheduled documents keep theirs", async () => {
		for (const id of ["p-gone", "p-published", "p-draft", "p-scheduled"]) await product(id);
		const cms = fakeCms({
			gone: ["p-gone"],
			status: { "p-draft": "draft", "p-scheduled": "scheduled" },
		});

		const summary = await tick(cms);

		expect(orphanLeg(summary)).toMatchObject({ ok: true, count: 1 });
		expect(orphanLeg(summary).incomplete).toBeUndefined();
		const gone = await row("p-gone");
		expect(gone).toMatchObject({ lifecycle: "deleted", active: false });
		expect(gone?.deletedAt).not.toBeNull();
		// The tombstone keeps its commercial data — order history reads it.
		expect(gone).toMatchObject({ sku: "SKU-p-gone", price: { amount: 1500, currency: "USD" } });
		for (const id of ["p-published", "p-draft", "p-scheduled"]) {
			expect(await row(id), id).toMatchObject({ lifecycle: "live", deletedAt: null });
		}
	});

	test("a read that FAILS never counts as gone: the row stays live, the leg fails loudly, and a later run judges it", async () => {
		await product("p-before", new Date(CREATED.getTime() - MINUTE_MS));
		await product("p-flaky");
		await product("p-after", new Date(CREATED.getTime() + MINUTE_MS));
		const cms = fakeCms({ gone: ["p-before", "p-flaky", "p-after"], failing: ["p-flaky"] });
		const cursors = memoryCursors();

		const failed = await tick(cms, { cursors });

		expect(orphanLeg(failed)).toMatchObject({ ok: false });
		expect(orphanLeg(failed).error).toMatch(/p-flaky/);
		expect(errors.some((line) => line.includes("product-orphans FAILED"))).toBe(true);
		// Never on an error: the flaky row and everything after it are untouched.
		expect(await row("p-flaky")).toMatchObject({ lifecycle: "live", deletedAt: null });
		expect(await row("p-after")).toMatchObject({ lifecycle: "live", deletedAt: null });
		// What it judged before the failure stays judged.
		expect(await row("p-before")).toMatchObject({ lifecycle: "deleted" });

		// The CMS recovers. A failed scan is retried at its cadence, from the row it
		// stopped at — not from the start.
		cms.failing.clear();
		cms.reads.length = 0;
		const retried = await tick(cms, { cursors, now: new Date(NOW.getTime() + 16 * MINUTE_MS) });
		expect(orphanLeg(retried)).toMatchObject({ ok: true, count: 2 });
		expect(cms.reads).toEqual(["p-flaky", "p-after"]);
		expect(await row("p-flaky")).toMatchObject({ lifecycle: "deleted" });
		expect(await row("p-after")).toMatchObject({ lifecycle: "deleted" });
	});

	test("a row younger than the grace window is not judged yet, and is judged once it is older", async () => {
		const young = new Date(NOW.getTime() - PRODUCT_ORPHAN_GRACE_MS + MINUTE_MS);
		await product("p-young", young);
		const cms = fakeCms({ gone: ["p-young"] });
		const cursors = memoryCursors();

		const early = await tick(cms, { cursors });
		expect(orphanLeg(early)).toMatchObject({ ok: true, count: 0 });
		expect(cms.reads).toEqual([]);
		expect(await row("p-young")).toMatchObject({ lifecycle: "live" });

		const later = await tick(cms, { cursors, now: new Date(NOW.getTime() + 16 * MINUTE_MS) });
		expect(orphanLeg(later)).toMatchObject({ ok: true, count: 1 });
		expect(await row("p-young")).toMatchObject({ lifecycle: "deleted" });
	});

	test("with no ctx.content the leg reports skipped and reads nothing", async () => {
		await product("p-unwired");
		const summary = await tick(undefined);
		expect(orphanLeg(summary)).toMatchObject({ ok: true, count: 0, skipped: true });
		expect(orphanLeg(summary).queries).toBe(0);
		expect(await row("p-unwired")).toMatchObject({ lifecycle: "live" });
	});
});

describe("the soft delete is the hook's own, and touches nothing else", () => {
	test("replay: a second pass changes nothing — the tombstone keeps its first deletedAt, and a tombstoned row is not read again", async () => {
		await product("p-replay");
		await product("p-kept");
		const cms = fakeCms({ gone: ["p-replay"] });
		const cursors = memoryCursors();

		const first = await tick(cms, { cursors });
		expect(orphanLeg(first)).toMatchObject({ ok: true, count: 1 });
		const tombstone = await row("p-replay");

		cms.reads.length = 0;
		const second = await tick(cms, { cursors, now: new Date(NOW.getTime() + 16 * MINUTE_MS) });
		expect(orphanLeg(second)).toMatchObject({ ok: true, count: 0 });
		expect(cms.reads).toEqual(["p-kept"]);
		expect(await row("p-replay")).toEqual(tombstone);

		// And the hook's own delivery, arriving late, is the same no-op: the sweep
		// wrote under the hook's idempotency key.
		await new EmdashProductCommerceStore({ storage, clock: new FixedClock(NOW) }).softDelete(
			toProductId("p-replay"),
			idempotencyKey("products:p-replay:deleted"),
		);
		expect(await row("p-replay")).toEqual(tombstone);
	});

	test("a deleted product's stock and its order's hold stay exactly where they were, and the order is not touched", async () => {
		const placed = await placeOrder(
			storage,
			"orphan-hold",
			new Date(NOW.getTime() + DAY_MS),
			CREATED,
		);
		// The product the order bought, priced on the sku the order holds.
		await product("prod-orphan-hold", CREATED, placed.sku);
		const orders = collectionOf<Record<string, unknown>>(storage, ORDERS_COLLECTION);
		const orderBefore = await orders.get(placed.id);
		const inventory = new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(NOW),
		});
		const onHandBefore = await inventory.getOnHand(toSku(placed.sku));

		const summary = await tick(fakeCms({ gone: ["prod-orphan-hold"] }));

		expect(orphanLeg(summary)).toMatchObject({ ok: true, count: 1 });
		expect(await row("prod-orphan-hold")).toMatchObject({ lifecycle: "deleted" });
		expect(await inventory.getOnHand(toSku(placed.sku))).toBe(onHandBefore);
		// The order snapshots its price and title; the delete never reaches them. (The
		// same tick's `hold-intents` leg does finish the order's own hold adoption —
		// that is its work, not this leg's — so the snapshot is what is compared.)
		const orderAfter = await orders.get(placed.id);
		for (const field of ["items", "totals", "state", "currency"] as const) {
			expect(orderAfter?.[field], field).toEqual(orderBefore?.[field]);
		}
		expect(orderAfter?.["orderId"]).toBe(toOrderId(placed.id));
		// The order's hold is still the order's: adopted, never released.
		expect(orderAfter?.["holdsReleased"]).toBeNull();
	});

	test("delete-and-recreate (new id): the old row is soft-deleted, the new row stays live, and the sku is free for the new product", async () => {
		// The old product held SKU-MUG. The merchant deleted it in the CMS (the hook's
		// delivery was lost) and created "the same" product again: EmDash mints a new
		// id, and the sync gave it a bare row.
		await product("p-mug-old", CREATED, "SKU-MUG");
		await new EmdashProductCommerceStore({ storage, clock: new FixedClock(CREATED) }).upsert(
			{ productId: toProductId("p-mug-new"), title: "Mug" },
			idempotencyKey("sync-p-mug-new"),
		);
		const store = new EmdashProductCommerceStore({ storage, clock: new FixedClock(NOW) });
		// While the orphan lives, the new product cannot take its sku.
		await expect(
			store.upsert(
				{ productId: toProductId("p-mug-new"), sku: toSku("SKU-MUG") },
				idempotencyKey("price-1"),
			),
		).rejects.toMatchObject({ name: "SkuConflictError" });

		const summary = await tick(fakeCms({ gone: ["p-mug-old"] }));

		expect(orphanLeg(summary)).toMatchObject({ ok: true, count: 1 });
		expect(await row("p-mug-old")).toMatchObject({ lifecycle: "deleted", sku: "SKU-MUG" });
		expect(await row("p-mug-new")).toMatchObject({ lifecycle: "live", deletedAt: null });
		const priced = await store.upsert(
			{ productId: toProductId("p-mug-new"), sku: toSku("SKU-MUG") },
			idempotencyKey("price-2"),
		);
		expect(priced.sku).toBe("SKU-MUG");
	});
});

describe("the walk fits the budget and pages across ticks", () => {
	test("on the Workers Free budget, a 40-product catalog is walked behind a cursor: every orphan is reached, nothing live is touched, and the pass ends", async () => {
		const ids = Array.from({ length: 40 }, (_, i) => `p-cat-${String(i).padStart(2, "0")}`);
		for (const [i, id] of ids.entries()) {
			await product(id, new Date(CREATED.getTime() + i * 1000));
		}
		const gone = ids.filter((_, i) => i % 5 === 2);
		const cms = fakeCms({ gone });
		const cursors: SweepCursorStore = memoryCursors();
		const counter: CallCounter = { calls: 0 };
		let deleted = 0;
		let ticks = 0;
		for (; ticks < 40; ticks++) {
			counter.calls = 0;
			const summary = await tick(cms, {
				cursors,
				counter,
				queryBudget: FREE,
				now: new Date(NOW.getTime() + ticks * MINUTE_MS),
			});
			// Never over the budget, counted from outside the sweep.
			expect(counter.calls, `tick ${String(ticks)}`).toBeLessThanOrEqual(FREE);
			const leg = orphanLeg(summary);
			expect(leg.ok, `tick ${String(ticks)}: ${leg.error ?? ""}`).toBe(true);
			deleted += leg.count;
			if (leg.notDue === true) break;
		}
		expect(deleted).toBe(gone.length);
		for (const id of ids) {
			expect((await row(id))?.lifecycle, id).toBe(gone.includes(id) ? "deleted" : "live");
		}
		// One full pass, then the leg rests for its cadence. Each live row was read once
		// per pass — a cursor, not a rescan from the top every tick. (An orphan found
		// with too little left for its delete stays ahead of the cursor, unjudged, and
		// is read again by the next tick — once more at most.)
		// Measured: 10 ticks, the first ones shared with the other scans' first runs.
		// At steady state an idle Free tick judges about six rows (its share, then the
		// second pass on what the tick has left): a 1000-product catalog measured one
		// pass in 154 ticks — two and a half hours — and 7 ticks on the Paid preset.
		expect(ticks, `one pass took ${String(ticks)} ticks`).toBeLessThanOrEqual(12);
		for (const id of ids) {
			const reads = cms.reads.filter((read) => read === id).length;
			if (gone.includes(id)) expect(reads, id).toBeLessThanOrEqual(2);
			else expect(reads, id).toBe(1);
		}
	});
});
