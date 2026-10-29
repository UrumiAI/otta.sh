/**
 * The `product-reconcile` sweep leg (issue #95): `product_commerce` re-derived from
 * the PUBLISHED CMS content when a content hook's sync was lost.
 *
 * Every content hook is fire-and-forget, and since publish atomicity a save of
 * live content sends nothing — so a lost publish no longer heals on the next
 * save. This suite pins, against a real SQLite document store and the host's
 * `ctx.content` as EmDash answers it (`get`/`list` read the content COLUMNS — on a
 * revision-supporting collection, the live data, never a pending draft):
 *  - the three failure states of the issue — a lost FIRST publish (no row / an
 *    inactive row), a lost publish of pending changes (stale title), a leaked draft
 *    title whose draft was discarded (at a NEWER watermark) — each repaired from the
 *    published content, never the draft;
 *  - a lost unpublish deactivates; a not-published document is never activated and
 *    its title never written; a tombstone is never touched; a newer lifecycle event
 *    is never overruled;
 *  - a lost variant sync on a published product is re-run;
 *  - an in-sync catalogue makes NO write, and a second tick after a repair makes none;
 *  - existing orders keep their snapshot;
 *  - the walk is bounded by the tick's query budget (Workers Free), resumes across
 *    ticks behind its cursor, and covers a catalogue larger than a page.
 */
import { cents, idempotencyKey, productId as toProductId } from "@urumi.ai/otta-domain";
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import {
	collectionOf,
	EmdashProductCommerceStore,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	type OrderDoc,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepSummary,
	type SweepCursorStore,
} from "../src/cron/index.js";
import {
	PRODUCT_RECONCILE_CURSOR,
	PRODUCT_RECONCILE_REPAIR_CALLS,
	planReconcile,
	RECONCILE_MAX_INTERRUPTS,
	RECONCILE_PAGE_SIZE,
} from "../src/cron/product-reconcile.js";
import {
	CONTENT_LIST_QUERIES,
	CONTENT_MISS_QUERIES,
	CONTENT_READ_QUERIES,
	LEG_QUERY_COSTS,
	MAINTENANCE_LEG_INTERVAL_MS,
} from "../src/cron/sweeps.js";
import { deriveSaveIdempotencyKey } from "../src/sync/derive-idempotency-key.js";
import {
	createAfterPublishHandler,
	createAfterSaveHandler,
	createAfterUnpublishHandler,
} from "../src/sync/hooks.js";
import type {
	ContentHookEvent,
	ContentReadAccess,
	ContentStateChangeEvent,
	PluginContext,
} from "../src/types.js";
import { memoryCursors, MINUTE_MS, placeOrder, sweepContext } from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const T1 = "2026-10-29T09:00:00.000Z";
const T2 = "2026-10-29T10:00:00.000Z";
const T3 = "2026-10-29T11:00:00.000Z";
const FREE = 30;
const PAID = 600;

let storage: StorageAccess;
let errors: string[];

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	errors = [];
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A CMS document as EmDash's `ctx.content` returns it: the content COLUMNS. */
interface Doc {
	id: string;
	status: string;
	updatedAt: string;
	version: number;
	createdAt: string;
	data: Record<string, unknown>;
	liveRevisionId?: string | null;
	draftRevisionId?: string | null;
}

/**
 * The host's CMS, standing in the way the fixtures' in-memory kv does: `list`
 * pages newest-first behind an opaque cursor (EmDash's keyset `createdAt DESC,
 * id`), clamped at 100, and `get` answers by id. Every call is charged as the
 * sweep charges it. The commerce documents stay real SQLite.
 */
class Cms {
	readonly docs = new Map<string, Doc>();
	listCalls = 0;
	/** Runs once, after the next reconcile-sized `list` has taken its page and
	 *  before it returns: a content hook landing between the reconcile's list and
	 *  its row read. (`product-orphans` lists too, one item at a time.) */
	afterList: (() => Promise<void>) | undefined;
	put(doc: Partial<Doc> & { id: string; title?: string }): Doc {
		const { title, ...rest } = doc;
		const full: Doc = {
			status: "published",
			updatedAt: T1,
			version: 1,
			createdAt: T1,
			data: title === undefined ? {} : { title },
			liveRevisionId: null,
			draftRevisionId: null,
			...rest,
		};
		this.docs.set(full.id, full);
		return full;
	}
	access(count: () => void): ContentReadAccess {
		const charge = (n: number): void => {
			for (let i = 0; i < n; i++) count();
		};
		const ordered = (): Doc[] =>
			[...this.docs.values()].toSorted(
				(a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
			);
		return {
			get: async (_collection, id) => {
				charge(CONTENT_MISS_QUERIES);
				const doc = this.docs.get(id);
				if (doc === undefined) return null;
				charge(CONTENT_READ_QUERIES - CONTENT_MISS_QUERIES);
				return structuredClone(doc) as unknown as Record<string, unknown>;
			},
			list: async (_collection, options) => {
				charge(CONTENT_LIST_QUERIES);
				this.listCalls++;
				const limit = Math.min(options?.limit ?? 50, 100);
				const all = ordered();
				const start = options?.cursor === undefined ? 0 : Number(options.cursor);
				const items = all.slice(start, start + limit);
				const next = start + limit;
				const page = items.map((doc) => structuredClone(doc) as unknown as Record<string, unknown>);
				const hook = limit === RECONCILE_PAGE_SIZE ? this.afterList : undefined;
				if (hook !== undefined) {
					this.afterList = undefined;
					await hook();
				}
				return {
					items: page,
					hasMore: next < all.length,
					...(next < all.length ? { cursor: String(next) } : {}),
				};
			},
		};
	}
}

/** Every write the tick makes to the commerce store, counted from outside. */
interface Writes {
	n: number;
}

function writeCounting(base: StorageAccess, writes: Writes): StorageAccess {
	const WRITES = new Set(["put", "delete", "compareAndSet", "updateIf", "createIfAbsent"]);
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(base)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (WRITES.has(String(prop))) writes.n++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}

async function tick(
	cms: Cms,
	cursors: SweepCursorStore,
	{
		offsetMs = 0,
		budget = PAID,
		writes,
	}: { offsetMs?: number; budget?: number; writes?: Writes } = {},
): Promise<CommerceSweepSummary> {
	const counted = writes === undefined ? storage : writeCounting(storage, writes);
	const ctx = sweepContext(counted, undefined, { [BACKGROUND_WORK_KEY]: budget });
	const withCms = Object.assign(Object.create(ctx) as PluginContext, {
		content: cms.access(() => undefined),
	});
	return await runCommerceSweeps(withCms, SWEEP_TASK_NAME, {
		cursors,
		now: new Date(NOW.getTime() + offsetMs),
	});
}

function leg(summary: CommerceSweepSummary) {
	const found = summary.legs.find((entry) => entry.leg === "product-reconcile");
	if (found === undefined) throw new Error("no product-reconcile leg in the summary");
	return found;
}

async function row(id: string): Promise<ProductCommerceDoc | null> {
	return await collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION).get(id);
}

function store(at: string): EmdashProductCommerceStore {
	return new EmdashProductCommerceStore({ storage, clock: new FixedClock(new Date(at)) });
}

/** A row exactly as the hooks would leave it after syncing `title` at `at`. */
async function syncedRow(
	id: string,
	title: string,
	at: string,
	{ active = true }: { active?: boolean } = {},
): Promise<void> {
	const s = store(at);
	await s.upsert(
		{ productId: toProductId(id), title, contentUpdatedAt: at },
		idempotencyKey(`products:${id}:${at}:seed`),
	);
	if (active) {
		await s.activate(toProductId(id), idempotencyKey(`products:${id}:published:${at}`), at);
	}
}

describe("the three failure states of #95, repaired from the published content", () => {
	test("a lost FIRST publish — no row at all — gets its row, its title and its activation", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "Linen Shirt", updatedAt: T2, version: 3 });
		expect(await row("p1")).toBeNull();

		const summary = await tick(cms, memoryCursors());

		expect(leg(summary)).toMatchObject({ ok: true, count: 1 });
		const doc = await row("p1");
		expect(doc).toMatchObject({
			lifecycle: "live",
			title: "Linen Shirt",
			active: true,
			contentUpdatedAt: T2,
			activeUpdatedAt: T2,
			// A repair writes no commercial field: the product is live but unpriced.
			price: null,
			sku: null,
		});
	});

	test("a lost FIRST publish over a DRAFT row the save hook made — the row is activated with the published title", async () => {
		const cms = new Cms();
		// The draft save synced (the real hook), with the draft's title.
		const draft = cms.put({ id: "p1", title: "Draft name", status: "draft", updatedAt: T1 });
		await createAfterSaveHandler()(
			{ collection: "products", content: { ...draft } } as unknown as ContentHookEvent,
			sweepContext(storage),
		);
		expect(await row("p1")).toMatchObject({ title: "Draft name", active: false });
		// …then the publish, whose hook was lost.
		cms.put({ id: "p1", title: "Published name", updatedAt: T2, version: 2 });

		await tick(cms, memoryCursors());

		expect(await row("p1")).toMatchObject({
			title: "Published name",
			active: true,
			contentUpdatedAt: T2,
		});
	});

	test("a lost publish of PENDING CHANGES — the row is active with the old title — takes the published title", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Old name", T1);
		cms.put({ id: "p1", title: "New name", updatedAt: T2, version: 5, liveRevisionId: "r2" });

		await tick(cms, memoryCursors());

		expect(await row("p1")).toMatchObject({
			title: "New name",
			active: true,
			contentUpdatedAt: T2,
		});
	});

	test("a LEAKED draft title whose draft was discarded is replaced by the published title — at the leak's newer watermark, never the draft", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Live name", T1);
		// The pre-fix leak: a draft save over live content pushed its title, stamped
		// with the draft save's NEWER watermark.
		await store(T3).upsert(
			{ productId: toProductId("p1"), title: "DRAFT name", contentUpdatedAt: T3 },
			idempotencyKey("products:p1:leak"),
		);
		// The draft was discarded (no plugin hook): the CMS's live columns still say
		// the published name, at the publish's watermark — OLDER than the leak's.
		cms.put({ id: "p1", title: "Live name", updatedAt: T1, version: 9, liveRevisionId: "r1" });

		await tick(cms, memoryCursors());

		const doc = await row("p1");
		expect(doc).toMatchObject({ title: "Live name", active: true });
		// Not moved backwards: a later real publish (newer than the leak) still wins.
		expect(doc?.contentUpdatedAt).toBe(T3);
	});

	test("a published product with a PENDING draft: the sweep reads the live columns, so the draft's title never lands", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Live name", T1);
		// EmDash keeps a pending draft in its revision; `ctx.content` returns the
		// content columns (the live data) with the two revision pointers.
		cms.put({
			id: "p1",
			title: "Live name",
			updatedAt: T1,
			liveRevisionId: "r1",
			draftRevisionId: "r2",
		});
		const writes = { n: 0 };

		await tick(cms, memoryCursors(), { writes });

		expect(await row("p1")).toMatchObject({ title: "Live name", active: true });
		expect(writes.n).toBe(0);
	});
});

describe("the publish gate: never live without a publish, never over a newer lifecycle event", () => {
	test("a lost UNPUBLISH: an active row whose document is a draft is deactivated", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Shirt", T1);
		cms.put({ id: "p1", title: "Shirt", status: "draft", updatedAt: T2 });

		const summary = await tick(cms, memoryCursors());

		expect(leg(summary).count).toBe(1);
		expect(await row("p1")).toMatchObject({ active: false, activeUpdatedAt: T2 });
	});

	test("a NOT-published document is never activated, never given a row, and its title is never written", async () => {
		const cms = new Cms();
		await syncedRow("p-draft", "Saved name", T1, { active: false });
		cms.put({ id: "p-draft", title: "Column name", status: "draft", updatedAt: T2 });
		cms.put({ id: "p-sched", title: "Scheduled", status: "scheduled", updatedAt: T2 });
		const writes = { n: 0 };

		const summary = await tick(cms, memoryCursors(), { writes });

		expect(leg(summary).count).toBe(0);
		expect(writes.n).toBe(0);
		expect(await row("p-draft")).toMatchObject({ title: "Saved name", active: false });
		expect(await row("p-sched")).toBeNull();
	});

	test("a TOMBSTONED row is never touched, even when its document is published", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Shirt", T1);
		await store(T1).softDelete(toProductId("p1"), idempotencyKey("products:p1:deleted"));
		cms.put({ id: "p1", title: "Shirt renamed", updatedAt: T2 });
		const writes = { n: 0 };

		await tick(cms, memoryCursors(), { writes });

		expect(writes.n).toBe(0);
		expect(await row("p1")).toMatchObject({ lifecycle: "deleted", active: false, title: "Shirt" });
	});

	test("a NEWER lifecycle event is never overruled: a row an unpublish deactivated after this content is left inactive", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Shirt", T1);
		await store(T3).deactivate(toProductId("p1"), idempotencyKey("products:p1:unpublished"), T3);
		// The CMS read says published at T2 — older than the gate's T3.
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });

		await tick(cms, memoryCursors());

		expect(await row("p1")).toMatchObject({ active: false, activeUpdatedAt: T3 });
	});

	test("a document with no parseable updatedAt is left alone — no write can be ordered", () => {
		expect(
			planReconcile({ id: "p1", status: "published", data: { title: "x" } }, undefined),
		).toEqual({ kind: "unordered" });
	});

	test("…and the walk says so, once a pass, even when the budget makes it re-read the page", async () => {
		const cms = new Cms();
		// Newest, so first on the page; drifted products after it make a Free tick stop
		// inside the page, so the page is read again on the next ticks.
		cms.put({ id: "p-bad", title: "Bad", updatedAt: "not a date", createdAt: T3 });
		for (const [i, id] of ["p0", "p1", "p2"].entries()) {
			cms.put({
				id,
				title: `Product ${id}`,
				updatedAt: T2,
				createdAt: new Date(Date.parse(T1) + i * 1000).toISOString(),
			});
		}
		const cursors = memoryCursors();
		const writes = { n: 0 };
		let ended = false;
		for (let t = 0; t < 30 && !ended; t++) {
			const outcome = leg(
				await tick(cms, cursors, { budget: FREE, offsetMs: t * MINUTE_MS, writes }),
			);
			ended = outcome.incomplete === undefined && outcome.deferred !== true;
		}

		expect(ended).toBe(true);
		const said = vi
			.mocked(console.warn)
			.mock.calls.filter((args) => String(args[0]).includes("product_id=p-bad has no parseable"));
		expect(said).toHaveLength(1);
		expect(await row("p-bad")).toBeNull();
		expect(await row("p2")).toMatchObject({ active: true });
	});
});

describe("variants", () => {
	test("a lost variant sync on a published product declares the sizes the live repeater carries, and orphans one it dropped", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Shirt", T1);
		await store(T1).applyVariantSync({
			productId: toProductId("p1"),
			contentUpdatedAt: T1,
			declares: [
				{ variantKey: "s", title: "Small", key: idempotencyKey("v-s") },
				{ variantKey: "xl", title: "XL", key: idempotencyKey("v-xl") },
			],
			orphanKey: (variantKey) => idempotencyKey(`o-${variantKey}`),
		});
		cms.put({
			id: "p1",
			updatedAt: T2,
			data: {
				title: "Shirt",
				variants: [
					{ key: "s", name: "Small" },
					{ key: "m", name: "Medium" },
				],
			},
		});

		await tick(cms, memoryCursors());

		const doc = await row("p1");
		expect(doc?.variants["m"]).toMatchObject({ title: "Medium", orphanedAt: null });
		expect(doc?.variants["s"]).toMatchObject({ title: "Small", orphanedAt: null });
		expect(doc?.variants["xl"]?.orphanedAt).not.toBeNull();

		// And then it is in sync: a later pass writes nothing.
		const writes = { n: 0 };
		await tick(cms, memoryCursors(), { writes, offsetMs: MAINTENANCE_LEG_INTERVAL_MS });
		expect(writes.n).toBe(0);
	});
});

describe("idempotent, and an in-sync catalogue costs only its pages", () => {
	test("a catalogue already in sync makes NO write, and reads one CMS page plus one row query per page", async () => {
		const cms = new Cms();
		for (let i = 0; i < 5; i++) {
			const id = `p${String(i)}`;
			await syncedRow(id, `Product ${String(i)}`, T1);
			cms.put({ id, title: `Product ${String(i)}`, updatedAt: T1 });
		}
		cms.put({ id: "p-draft", title: "Draft", status: "draft", updatedAt: T1 });
		const writes = { n: 0 };

		const summary = await tick(cms, memoryCursors(), { writes });

		expect(leg(summary)).toMatchObject({ ok: true, count: 0 });
		expect(leg(summary).incomplete).toBeUndefined();
		expect(writes.n).toBe(0);
		// The cursor read, the page, its rows — nothing per product. (The state's
		// cursor write is skipped when nothing changed.)
		expect(leg(summary).queries).toBeLessThanOrEqual(LEG_QUERY_COSTS["product-reconcile"].entry);
	});

	test("a repair is done once: the next pass finds the product in sync and writes nothing", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });
		const cursors = memoryCursors();
		expect(leg(await tick(cms, cursors)).count).toBe(1);

		const writes = { n: 0 };
		const again = await tick(cms, cursors, { writes, offsetMs: MAINTENANCE_LEG_INTERVAL_MS });

		expect(leg(again).count).toBe(0);
		expect(writes.n).toBe(0);
	});

	test("a maintenance leg: a completed pass is not repeated before its cadence", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });
		const cursors = memoryCursors();
		await tick(cms, cursors);
		const listed = cms.listCalls;

		expect(leg(await tick(cms, cursors, { offsetMs: MINUTE_MS })).notDue).toBe(true);
		expect(cms.listCalls).toBe(listed);
	});

	test("an existing order keeps its snapshot when the product's title is repaired", async () => {
		const cms = new Cms();
		const placed = await placeOrder(storage, "snap", new Date(NOW.getTime() + 3_600_000), NOW);
		const id = "prod-snap";
		await syncedRow(id, "Budget Widget", T1);
		cms.put({ id, title: "Renamed Widget", updatedAt: T2 });

		await tick(cms, memoryCursors());

		expect((await row(id))?.title).toBe("Renamed Widget");
		const order = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(placed.id);
		expect(order?.items[0]).toMatchObject({ title: "Budget Widget", unitPrice: cents(1000) });
	});
});

describe("the cost table (LEG_QUERY_COSTS)", () => {
	test("one repair — no row, a title, an activation and a two-size repeater — fits PRODUCT_RECONCILE_REPAIR_CALLS on top of the entry and the cursor write", async () => {
		const cms = new Cms();
		cms.put({
			id: "p1",
			updatedAt: T2,
			data: {
				title: "Shirt",
				variants: [
					{ key: "s", name: "Small" },
					{ key: "m", name: "Medium" },
				],
			},
		});

		const outcome = leg(await tick(cms, memoryCursors()));

		expect(outcome.count).toBe(1);
		const { entry, unit } = LEG_QUERY_COSTS["product-reconcile"];
		// The suite's cursor store is not the counted kv, so neither the entry's cursor
		// read and write nor the repair's attempt write are in `queries`: what is left
		// over the page and its row read is the repair — the document re-read (3), the
		// sync (6) and the row re-read (1). Measured: 10; the unit adds the attempt's
		// cursor write and two calls of compare-and-set headroom.
		const repair = outcome.queries - (entry - 2);
		expect(repair).toBe(10);
		expect(unit).toBe(PRODUCT_RECONCILE_REPAIR_CALLS);
		expect(repair + 1 + 2).toBe(unit);
		expect((await row("p1"))?.variants["m"]?.title).toBe("Medium");
	});
});

describe("bounded by the tick's budget, resumed across ticks", () => {
	test("on Workers Free a catalogue-wide outage heals over ticks: every tick stays inside the budget, the cursor walks every page, and the pass ends", async () => {
		const cms = new Cms();
		const N = RECONCILE_PAGE_SIZE * 2 + 7;
		for (let i = 0; i < N; i++) {
			const id = `p${String(i).padStart(3, "0")}`;
			// Distinct creation times, so the CMS's own order is stable.
			cms.put({
				id,
				title: `Product ${String(i)}`,
				updatedAt: T2,
				createdAt: new Date(Date.parse(T1) + i * 1000).toISOString(),
			});
		}
		const cursors = memoryCursors();
		let ticks = 0;
		let repaired = 0;
		let finished = false;
		while (!finished && ticks < 400) {
			const summary = await tick(cms, cursors, { budget: FREE, offsetMs: ticks * MINUTE_MS });
			ticks++;
			expect(summary.budget.queriesUsed).toBeLessThanOrEqual(FREE);
			const outcome = leg(summary);
			expect(outcome.ok).toBe(true);
			repaired += outcome.count;
			if (outcome.count > 0) {
				// Bounded per tick: a Free tick has room for one repair (each re-reads its
				// document and, after the sync, its row), never a page.
				expect(outcome.count).toBeLessThanOrEqual(1);
			}
			finished = outcome.count === 0 && outcome.incomplete === undefined && !outcome.deferred;
			if (outcome.notDue === true) finished = true;
		}
		expect(repaired).toBe(N);
		for (const id of cms.docs.keys()) {
			expect(await row(id), id).toMatchObject({ active: true, lifecycle: "live" });
		}
		// More than one tick, and more than one page: a resumed walk, not one big bite.
		expect(ticks).toBeGreaterThan(N / 3);
		expect(errors).toEqual([]);
	});

	test("on a Paid budget the same walk takes a handful of ticks", async () => {
		const cms = new Cms();
		const N = RECONCILE_PAGE_SIZE + 10;
		for (let i = 0; i < N; i++) {
			cms.put({
				id: `p${String(i).padStart(3, "0")}`,
				title: `Product ${String(i)}`,
				updatedAt: T2,
				createdAt: new Date(Date.parse(T1) + i * 1000).toISOString(),
			});
		}
		const cursors = memoryCursors();
		let repaired = 0;
		for (let t = 0; t < 10; t++) {
			const summary = await tick(cms, cursors, { budget: PAID, offsetMs: t * MINUTE_MS });
			expect(summary.budget.queriesUsed).toBeLessThanOrEqual(PAID);
			repaired += leg(summary).count;
		}
		expect(repaired).toBe(N);
	});

	test("a lost cursor costs a re-read, never a wrong write", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });
		const cursors = memoryCursors();
		await cursors.write("product-reconcile", "{not json");

		await tick(cms, cursors);

		expect(await row("p1")).toMatchObject({ title: "Shirt", active: true });
	});
});

describe("a hook that lands between the page and its rows never loses to the stale page", () => {
	test("a PUBLISH between the list and the row read: the stale content is never written at the publish's watermark", async () => {
		const cms = new Cms();
		await syncedRow("p1", "Old name", T1);
		cms.put({
			id: "p1",
			updatedAt: T1,
			data: { title: "Old name", variants: [{ key: "s", name: "Small" }] },
		});
		// The publish lands after the sweep took its page and before it reads the rows:
		// a new name, and a size the stale page does not declare.
		cms.afterList = async () => {
			const published = cms.put({
				id: "p1",
				updatedAt: T3,
				version: 2,
				data: {
					title: "New name",
					variants: [
						{ key: "s", name: "Small" },
						{ key: "l", name: "Large" },
					],
				},
			});
			await createAfterPublishHandler()(
				{ collection: "products", content: { ...published } } as unknown as ContentStateChangeEvent,
				sweepContext(storage),
			);
		};
		const writes = { n: 0 };

		const summary = await tick(cms, memoryCursors(), { writes });

		// The re-read saw the newer document: nothing was written, nothing counted.
		expect(writes.n).toBe(0);
		expect(leg(summary).count).toBe(0);
		const doc = await row("p1");
		expect(doc).toMatchObject({ title: "New name", contentUpdatedAt: T3, active: true });
		expect(doc?.variants["l"]).toMatchObject({ title: "Large", orphanedAt: null });
	});

	test("an UNPUBLISH between the list and the row read: a product the merchant took down is never activated", async () => {
		const cms = new Cms();
		// A lost first publish: the row is inactive, its gate never stamped.
		await syncedRow("p1", "Shirt", T1, { active: false });
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });
		cms.afterList = async () => {
			const unpublished = cms.put({ id: "p1", title: "Shirt", status: "draft", updatedAt: T3 });
			// A no-op on an inactive row: it stamps no gate watermark.
			await createAfterUnpublishHandler()(
				{
					collection: "products",
					content: { ...unpublished },
				} as unknown as ContentStateChangeEvent,
				sweepContext(storage),
			);
		};

		await tick(cms, memoryCursors());

		expect(await row("p1")).toMatchObject({ active: false });
	});
});

describe("the walk always moves", () => {
	test("on Workers Free, a repair that is a no-op (a pending leaked draft under its REAL save key) neither wedges the walk nor counts as repaired", async () => {
		const cms = new Cms();
		// The leak: the draft save's upsert under the save key the live columns also
		// derive (same `updatedAt`, same `version`), so the sweep's upsert replays it.
		await syncedRow("p-leak", "Live name", T1);
		await store(T2).upsert(
			{ productId: toProductId("p-leak"), title: "DRAFT name", contentUpdatedAt: T2 },
			idempotencyKey(deriveSaveIdempotencyKey("products", "p-leak", T2, 2)),
		);
		// Newest, so first on the page…
		cms.put({
			id: "p-leak",
			title: "Live name",
			updatedAt: T2,
			version: 2,
			createdAt: T3,
			liveRevisionId: "r1",
			draftRevisionId: "r2",
		});
		// …and drifted products after it on the same page.
		const others = ["p0", "p1", "p2", "p3"];
		others.forEach((id, i) => {
			cms.put({
				id,
				title: `Product ${id}`,
				updatedAt: T2,
				createdAt: new Date(Date.parse(T1) + i * 1000).toISOString(),
			});
		});
		const cursors = memoryCursors();
		const anomalies: string[] = [];
		let repaired = 0;
		let ticks = 0;
		let ended = false;
		while (!ended && ticks < 30) {
			const summary = await tick(cms, cursors, { budget: FREE, offsetMs: ticks * MINUTE_MS });
			ticks++;
			expect(summary.budget.queriesUsed).toBeLessThanOrEqual(FREE);
			const outcome = leg(summary);
			repaired += outcome.count;
			anomalies.push(...(outcome.anomalies ?? []));
			ended = outcome.incomplete === undefined && outcome.deferred !== true;
		}

		expect(ended).toBe(true);
		for (const id of others) {
			expect(await row(id), id).toMatchObject({ title: `Product ${id}`, active: true });
		}
		// Counted only where the write held; the no-op is reported once, as such.
		expect(repaired).toBe(others.length);
		expect(anomalies.filter((line) => line.includes("p-leak"))).toEqual([
			expect.stringContaining("product p-leak was attempted and is still out of sync"),
		]);
		expect((await row("p-leak"))?.title).toBe("DRAFT name");
	});

	test(`a product cut short by the tick's ceiling ${String(RECONCILE_MAX_INTERRUPTS)} runs in a row is stepped past, logged, and retried next pass`, async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "One", updatedAt: T2, createdAt: T3 });
		cms.put({ id: "p2", title: "Two", updatedAt: T2, createdAt: T1 });
		const cursors = memoryCursors();
		await cursors.write(
			PRODUCT_RECONCILE_CURSOR,
			JSON.stringify({
				cursor: null,
				attempted: [],
				interrupted: { p1: RECONCILE_MAX_INTERRUPTS },
			}),
		);

		const summary = await tick(cms, cursors);

		expect(await row("p1")).toBeNull();
		expect(await row("p2")).toMatchObject({ title: "Two", active: true });
		expect(leg(summary).anomalies).toEqual([expect.stringContaining("product p1 was cut short")]);

		await tick(cms, cursors, { offsetMs: MAINTENANCE_LEG_INTERVAL_MS });
		expect(await row("p1")).toMatchObject({ title: "One", active: true });
	});

	test("the place is saved after every page, not only when the walk stops", async () => {
		const cms = new Cms();
		const N = RECONCILE_PAGE_SIZE * 2 + 3;
		for (let i = 0; i < N; i++) {
			const id = `p${String(i).padStart(3, "0")}`;
			await syncedRow(id, `Product ${String(i)}`, T1);
			cms.put({
				id,
				title: `Product ${String(i)}`,
				updatedAt: T1,
				createdAt: new Date(Date.parse(T1) + i * 1000).toISOString(),
			});
		}
		const base = memoryCursors();
		const written: string[] = [];
		const cursors: SweepCursorStore = {
			read: async (name) => await base.read(name),
			write: async (name, value) => {
				if (name === PRODUCT_RECONCILE_CURSOR) written.push(value);
				await base.write(name, value);
			},
		};

		const summary = await tick(cms, cursors);

		expect(leg(summary).incomplete).toBeUndefined();
		const places = written.map((value) => (JSON.parse(value) as { cursor: string | null }).cursor);
		// Past page one, past page two, then the wrap at the end of the catalogue.
		expect(places).toEqual([String(RECONCILE_PAGE_SIZE), String(RECONCILE_PAGE_SIZE * 2), null]);
	});
});
