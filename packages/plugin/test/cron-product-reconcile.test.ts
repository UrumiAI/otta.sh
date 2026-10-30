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
	PRODUCT_RECONCILE_CHECK_CALLS,
	reconcileProductCommerce,
	PRODUCT_RECONCILE_CURSOR,
	PRODUCT_RECONCILE_REPAIR_CALLS,
	planReconcile,
	RECONCILE_MAX_INTERRUPTS,
	RECONCILE_PAGE_SIZE,
	RECONCILE_PASS_INTERVAL_FREE_MS,
	RECONCILE_PASS_INTERVAL_PAID_MS,
	RECONCILE_REPAIRS_PER_DAY_FREE,
	reconcilePassIntervalMs,
	reconcileRepairsDailyCap,
} from "../src/cron/product-reconcile.js";
import {
	CONTENT_LIST_QUERIES,
	CONTENT_MISS_QUERIES,
	CONTENT_READ_QUERIES,
	LEG_QUERY_COSTS,
	MAINTENANCE_LEG_INTERVAL_MS,
} from "../src/cron/sweeps.js";
import { SweepQueryCeilingError } from "../src/cron/tick-budget.js";
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
	/** The reconcile's own page reads (`product-orphans` lists one item at a time). */
	pageLists = 0;
	/** Runs once, after the next reconcile-sized `list` has taken its page and
	 *  before it returns: a content hook landing between the reconcile's list and
	 *  its row read. (`product-orphans` lists too, one item at a time.) */
	afterList: (() => Promise<void>) | undefined;
	/** Runs once, after the next `get` of `id` has taken its answer and before it
	 *  returns: a content hook landing between the reconcile's document read and its
	 *  write. */
	afterGet: { id: string; run: () => Promise<void> } | undefined;
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
				const answer = structuredClone(doc) as unknown as Record<string, unknown>;
				const hook = this.afterGet?.id === id ? this.afterGet : undefined;
				if (hook !== undefined) {
					this.afterGet = undefined;
					await hook.run();
				}
				return answer;
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
				if (limit === RECONCILE_PAGE_SIZE) this.pageLists++;
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

/**
 * The plugin's kv as one store kept across ticks. Handed to `tick` in place of a
 * cursor store, the sweep keeps its cursors (and its own state) in `ctx.kv` as in
 * production, so every cursor read and write is charged to the tick's budget.
 */
class PersistentKv {
	readonly map = new Map<string, unknown>();
}

async function tick(
	cms: Cms,
	cursors: SweepCursorStore | PersistentKv,
	{
		offsetMs = 0,
		budget = PAID,
		writes,
	}: { offsetMs?: number; budget?: number; writes?: Writes } = {},
): Promise<CommerceSweepSummary> {
	const counted = writes === undefined ? storage : writeCounting(storage, writes);
	const ctx = sweepContext(counted, undefined, { [BACKGROUND_WORK_KEY]: budget });
	let base: PluginContext = ctx;
	if (cursors instanceof PersistentKv) {
		const map = cursors.map;
		map.set(BACKGROUND_WORK_KEY, budget);
		base = Object.assign(Object.create(ctx) as PluginContext, {
			kv: {
				get: async (key: string) => (map.has(key) ? map.get(key) : null),
				set: async (key: string, value: unknown) => {
					map.set(key, value);
				},
				delete: async (key: string) => map.delete(key),
				list: async () => [...map].map(([key, value]) => ({ key, value })),
			},
		});
	}
	const withCms = Object.assign(Object.create(base) as PluginContext, {
		content: cms.access(() => undefined),
	});
	return await runCommerceSweeps(withCms, SWEEP_TASK_NAME, {
		...(cursors instanceof PersistentKv ? {} : { cursors }),
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
		const cursors = new PersistentKv();
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
		// The entry: the cursor read, the list, and a full page's two row reads.
		expect(entry).toBe(1 + CONTENT_LIST_QUERIES + 2);
		// The suite's cursor store is not the counted kv, so neither the cursor read and
		// writes nor each visit's attempt write are in `queries`. Past the page's list and
		// its ONE row read (a page of one is one `in` chunk): the repair's visit — the row
		// read (1), the document read (3) — and the sync (6); then the visit that CHECKS
		// it — the row read and the document read again (4). Measured: 10 + 4; each unit
		// adds its attempt write, and nothing else (it must start in an idle Free tick).
		const visits = outcome.queries - (CONTENT_LIST_QUERIES + 1);
		expect(visits).toBe(10 + 4);
		expect(unit).toBe(PRODUCT_RECONCILE_REPAIR_CALLS);
		expect(PRODUCT_RECONCILE_REPAIR_CALLS).toBe(10 + 1);
		expect(PRODUCT_RECONCILE_CHECK_CALLS).toBe(4 + 1);
		expect((await row("p1"))?.variants["m"]?.title).toBe("Medium");
	});
});

describe("bounded by the tick's budget, resumed across ticks", () => {
	test("on Workers Free a catalogue-wide outage heals over ticks: every tick stays inside the budget, the cursor walks every page, and the pass ends", async () => {
		const cms = new Cms();
		const N = RECONCILE_PAGE_SIZE + 7;
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
		// The cursors live in the counted kv, so their reads and writes are inside FREE.
		const cursors = new PersistentKv();
		let ticks = 0;
		let repaired = 0;
		let finished = false;
		while (!finished && ticks < 600) {
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
		// Each page is LISTED ONCE for the whole pass — the host's whole-collection count
		// runs beside every list, so a resumed page must not be listed again.
		expect(cms.pageLists).toBe(Math.ceil(N / RECONCILE_PAGE_SIZE));
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
	test("on Workers Free, a repair that is a no-op (a pending leaked draft under its REAL save key) is never retried as an error, never wedges the walk, and never counts as repaired", async () => {
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
		const cursors = new PersistentKv();
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
		// Counted only where a write held. The leak is not attempted at all — its upsert
		// would replay — and is said ONCE a pass, at info, never as an error.
		expect(repaired).toBe(others.length);
		expect(anomalies).toEqual([]);
		expect(errors).toEqual([]);
		const said = vi
			.mocked(console.info)
			.mock.calls.filter((args) => String(args[0]).includes("product_id=p-leak carries a title"));
		expect(said).toHaveLength(1);
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

		await tick(cms, cursors, { offsetMs: RECONCILE_PASS_INTERVAL_PAID_MS });
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

describe("the pass interval: a pass's D1 rows read are paid once per interval, from its START", () => {
	test("Free waits a day between pass starts, Paid six hours", () => {
		expect(reconcilePassIntervalMs(FREE)).toBe(RECONCILE_PASS_INTERVAL_FREE_MS);
		expect(reconcilePassIntervalMs(PAID)).toBe(RECONCILE_PASS_INTERVAL_PAID_MS);
		expect(RECONCILE_PASS_INTERVAL_FREE_MS).toBe(24 * 60 * 60 * 1000);
		expect(RECONCILE_PASS_INTERVAL_PAID_MS).toBe(6 * 60 * 60 * 1000);
	});

	test("a COMPLETED pass does not restart before the interval from its start, and does after it", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });
		const cursors = memoryCursors();
		expect(leg(await tick(cms, cursors))).toMatchObject({ count: 1 });
		const listed = cms.pageLists;
		// Lost again after the pass: the next pass must not see it before its time.
		await store(T3).deactivate(toProductId("p1"), idempotencyKey("products:p1:x"), T3);
		cms.put({ id: "p1", title: "Shirt", updatedAt: T3 });

		// Past the fifteen-minute cadence, inside the interval: not due, and no CMS list.
		for (const offsetMs of [
			MAINTENANCE_LEG_INTERVAL_MS,
			RECONCILE_PASS_INTERVAL_PAID_MS - MINUTE_MS,
		]) {
			expect(leg(await tick(cms, cursors, { offsetMs }))).toMatchObject({ count: 0, notDue: true });
		}
		expect(cms.pageLists).toBe(listed);
		expect(await row("p1")).toMatchObject({ active: false });

		// Past the interval from the START of the last pass (and the leg's own cadence
		// after the probe just above): a new pass, and the repair.
		const next = RECONCILE_PASS_INTERVAL_PAID_MS - MINUTE_MS + MAINTENANCE_LEG_INTERVAL_MS;
		expect(leg(await tick(cms, cursors, { offsetMs: next }))).toMatchObject({ count: 1 });
		expect(await row("p1")).toMatchObject({ active: true });
	});

	test("an UNFINISHED pass resumes every tick, and its start — not its end — times the next one", async () => {
		const cms = new Cms();
		const N = RECONCILE_PAGE_SIZE + 5;
		for (let i = 0; i < N; i++) {
			cms.put({
				id: `p${String(i).padStart(3, "0")}`,
				title: `Product ${String(i)}`,
				updatedAt: T2,
				createdAt: new Date(Date.parse(T1) + i * 1000).toISOString(),
			});
		}
		const cursors = new PersistentKv();
		let t = 0;
		let ended = false;
		let firstRunAt: number | undefined;
		for (; t < 600 && !ended; t++) {
			const outcome = leg(await tick(cms, cursors, { budget: FREE, offsetMs: t * MINUTE_MS }));
			// Never "not due" while the pass is unfinished.
			expect(outcome.notDue).toBeUndefined();
			if (firstRunAt === undefined && outcome.deferred !== true) firstRunAt = t;
			ended = outcome.incomplete === undefined && outcome.deferred !== true;
		}
		expect(ended).toBe(true);
		const endedAt = t - 1;
		expect(endedAt).toBeGreaterThan(firstRunAt ?? 0);

		// The next pass is due a day after the FIRST tick of this one, not after its end:
		// no page is read before then (the leg may be deferred on a Free tick, or find
		// itself not due — either way it reads nothing), and one is at or soon after it.
		const dueAt = (firstRunAt ?? 0) * MINUTE_MS + RECONCILE_PASS_INTERVAL_FREE_MS;
		const read = cms.pageLists;
		for (const offsetMs of [endedAt * MINUTE_MS + MAINTENANCE_LEG_INTERVAL_MS, dueAt - MINUTE_MS]) {
			const early = leg(await tick(cms, cursors, { budget: FREE, offsetMs }));
			expect(early.notDue === true || early.deferred === true, JSON.stringify(early)).toBe(true);
		}
		expect(cms.pageLists).toBe(read);
		for (let k = 0; k < 120 && cms.pageLists === read; k++) {
			await tick(cms, cursors, { budget: FREE, offsetMs: dueAt + k * MINUTE_MS });
		}
		expect(cms.pageLists).toBeGreaterThan(read);
	});
});

describe("log levels", () => {
	test("a product with no commerce row at all is a FIRST sync, said at info, not as a lost publish", async () => {
		const cms = new Cms();
		cms.put({ id: "p-new", title: "New", updatedAt: T2 });
		await syncedRow("p-old", "Old name", T1);
		cms.put({ id: "p-old", title: "New name", updatedAt: T2 });

		await tick(cms, memoryCursors());

		const info = vi.mocked(console.info).mock.calls.map((args) => String(args[0]));
		const warn = vi.mocked(console.warn).mock.calls.map((args) => String(args[0]));
		expect(info.filter((line) => line.includes("product_id=p-new"))).toEqual([
			expect.stringContaining("(a first sync)"),
		]);
		expect(warn.filter((line) => line.includes("product_id=p-new"))).toEqual([]);
		expect(warn.filter((line) => line.includes("product_id=p-old"))).toEqual([
			expect.stringContaining("a lost publish sync"),
		]);
	});
});

describe("the flip window: a lifecycle event between the repair's document read and its write", () => {
	test("an UNPUBLISH landing after the read and before the activate: the check visit takes the product off sale again", async () => {
		const cms = new Cms();
		// A lost first publish: the row is inactive, so the unpublish hook's deactivate
		// will be a no-op that stamps nothing.
		await syncedRow("p1", "Shirt", T1, { active: false });
		cms.put({ id: "p1", title: "Shirt", updatedAt: T2 });
		// Armed by the reconcile's own list, so it fires on the REPAIR's document read
		// (not on `product-orphans`' reads earlier in the tick).
		cms.afterList = async () => {
			cms.afterGet = {
				id: "p1",
				run: async () => {
					const unpublished = cms.put({ id: "p1", title: "Shirt", status: "draft", updatedAt: T3 });
					await createAfterUnpublishHandler()(
						{
							collection: "products",
							content: { ...unpublished },
						} as unknown as ContentStateChangeEvent,
						sweepContext(storage),
					);
				},
			};
		};

		const summary = await tick(cms, memoryCursors());

		// The repair activated at T2; its check read the unpublished document and
		// deactivated at the unpublish's own watermark, in the same tick.
		expect(await row("p1")).toMatchObject({ active: false, activeUpdatedAt: T3 });
		expect(leg(summary).anomalies).toBeUndefined();
	});

	test("a REPUBLISH landing after the read and before the deactivate: the check visit puts the product back on sale", async () => {
		const cms = new Cms();
		// A lost unpublish: the row is active, so the publish hook's activate will be a
		// no-op that stamps nothing.
		await syncedRow("p1", "Shirt", T1);
		cms.put({ id: "p1", title: "Shirt", status: "draft", updatedAt: T2 });
		cms.afterList = async () => {
			cms.afterGet = {
				id: "p1",
				run: async () => {
					const published = cms.put({ id: "p1", title: "Shirt", updatedAt: T3, version: 2 });
					await createAfterPublishHandler()(
						{
							collection: "products",
							content: { ...published },
						} as unknown as ContentStateChangeEvent,
						sweepContext(storage),
					);
				},
			};
		};

		const summary = await tick(cms, memoryCursors());

		expect(await row("p1")).toMatchObject({ active: true, activeUpdatedAt: T3 });
		expect(leg(summary).anomalies).toBeUndefined();
	});

	test("a product nominated for a DEACTIVATION that now needs a SYNC is gated on the sync's cost: without room, nothing is written and it stays pending", async () => {
		// Driven directly, with a budget that has room for the nominated deactivation's
		// visit (7) but not for the sync's writes after it.
		let remaining = 9;
		const spend = (n: number): void => {
			remaining -= n;
		};
		const budget = {
			stopped: false,
			gate: () => () => true,
			remainingQueries: () => remaining,
		} as unknown as Parameters<typeof reconcileProductCommerce>[4];
		const active = {
			lifecycle: "live",
			title: "Shirt",
			titleRejection: null,
			active: true,
			contentUpdatedAt: T1,
			activeUpdatedAt: T1,
			variants: {},
		};
		const listed = {
			id: "p1",
			status: "draft",
			updatedAt: T2,
			version: 1,
			data: { title: "Shirt" },
		};
		// Republished since the list: the fresh plan is a sync.
		const fresh = { ...listed, status: "published", updatedAt: T3, version: 2 };
		const writes: string[] = [];
		const cursors: SweepCursorStore = {
			read: async () => null,
			write: async (_name, value) => {
				spend(1);
				writes.push(value);
			},
		};
		const result = await reconcileProductCommerce(
			{} as PluginContext,
			{
				many: async () => new Map([["p1", active]]),
				one: async () => {
					spend(1);
					return active;
				},
			},
			{
				list: async () => ({ items: [listed], hasMore: false }),
				get: async () => {
					spend(3);
					return fresh;
				},
			},
			cursors,
			budget,
			{ now: NOW, passIntervalMs: RECONCILE_PASS_INTERVAL_PAID_MS },
		);

		expect(result).toMatchObject({ count: 0, incomplete: true });
		const last = JSON.parse(writes.at(-1) ?? "{}") as {
			pending?: { id: string }[];
			interrupted?: Record<string, number>;
		};
		// Still nominated, and this visit is not counted against it.
		expect(last.pending?.map((entry) => entry.id)).toEqual(["p1"]);
		expect(last.interrupted).toEqual({});
	});
});

describe("the daily repair cap: on Workers Free a first-install heal cannot spend D1 Free's rows written", () => {
	/** The leg's kv document, as the suite reads it back. */
	interface Stored {
		day?: string | null;
		repairsToday?: number;
		passStartedAt?: string | null;
		pending?: { id: string }[];
	}
	const stored = async (cursors: SweepCursorStore): Promise<Stored> =>
		JSON.parse((await cursors.read(PRODUCT_RECONCILE_CURSOR)) ?? "{}") as Stored;
	const TODAY = NOW.toISOString().slice(0, 10);

	test("on the deploy day of a new index layout a Free tick repairs nothing and waits its cadence; the next UTC day it repairs", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "Linen Shirt", updatedAt: T2, version: 3 });
		const cursors = memoryCursors();
		// The tick state the release before left: another index layout, so EmDash is
		// building this one's indexes today and the day's rows written are theirs.
		await cursors.write("state", JSON.stringify({ indexLayout: "an older layout" }));
		// The tick's other legs are due too; the first run that reaches this leg is held.
		let held: ReturnType<typeof leg> | undefined;
		for (let t = 0; t < 10 && held === undefined; t++) {
			const outcome = leg(await tick(cms, cursors, { budget: FREE, offsetMs: t * MINUTE_MS }));
			if (outcome.deferred !== true) held = outcome;
		}
		expect(held).toMatchObject({ count: 0, waitsCadence: true });
		expect(await row("p1")).toBeNull();
		expect(await cursors.read(PRODUCT_RECONCILE_CURSOR)).toBeNull();
		// The next UTC day.
		let repaired = 0;
		for (let t = 0; t < 10 && repaired === 0; t++) {
			const offsetMs = (24 * 60 + t) * MINUTE_MS;
			repaired += leg(await tick(cms, cursors, { budget: FREE, offsetMs })).count;
		}
		expect(repaired).toBe(1);
		expect(await row("p1")).toMatchObject({ title: "Linen Shirt", active: true });
	});

	test("the cap applies at any budget Workers Free can run (50 or less), and none above it", () => {
		expect(RECONCILE_REPAIRS_PER_DAY_FREE).toBe(200);
		expect(reconcileRepairsDailyCap(FREE)).toBe(RECONCILE_REPAIRS_PER_DAY_FREE);
		expect(reconcileRepairsDailyCap(50)).toBe(RECONCILE_REPAIRS_PER_DAY_FREE);
		expect(reconcileRepairsDailyCap(51)).toBeNull();
		expect(reconcileRepairsDailyCap(PAID)).toBeNull();
	});

	test("on Free, the day's cap stops the repairs and the leg waits its cadence; the pass keeps its place and finishes the next UTC day", async () => {
		const cms = new Cms();
		const ids = ["p1", "p2", "p3"];
		ids.forEach((id, i) => {
			cms.put({
				id,
				title: `Product ${id}`,
				updatedAt: T2,
				createdAt: new Date(Date.parse(T3) - i * 1000).toISOString(),
			});
		});
		const cursors = memoryCursors();
		// One repair left of today's allowance.
		await cursors.write(
			PRODUCT_RECONCILE_CURSOR,
			JSON.stringify({ day: TODAY, repairsToday: RECONCILE_REPAIRS_PER_DAY_FREE - 1 }),
		);
		const logged = vi.mocked(console.log);
		let cappedAt: number | undefined;
		for (let t = 0; t < 60; t++) {
			logged.mockClear();
			const outcome = leg(await tick(cms, cursors, { budget: FREE, offsetMs: t * MINUTE_MS }));
			if (cappedAt === undefined && outcome.waitsCadence === true) {
				cappedAt = t;
				expect(outcome.incomplete).toBe(true);
			} else if (cappedAt !== undefined && outcome.waitsCadence === true) {
				// A capped cadence that does nothing is silent: no tick line every 15 minutes.
				expect(outcome.count).toBe(0);
				expect(logged.mock.calls.filter((args) => String(args[0]).includes("cron sweep"))).toEqual(
					[],
				);
			}
			if (cappedAt === t - 1) {
				// Stamped: not run again before its cadence.
				expect(outcome.notDue).toBe(true);
			}
		}
		expect(cappedAt).toBeDefined();
		const healed = [];
		for (const id of ids) if ((await row(id)) !== null) healed.push(id);
		expect(healed).toEqual(["p1"]);
		// The pass is NOT finished: its start and the products left are kept.
		const capped = await stored(cursors);
		expect(capped).toMatchObject({ day: TODAY, repairsToday: RECONCILE_REPAIRS_PER_DAY_FREE });
		expect(capped.passStartedAt).not.toBeNull();
		expect(capped.pending?.map((entry) => entry.id)).toEqual(["p2", "p3"]);

		// After 00:00 UTC the count starts again and the pass resumes where it was.
		const nextDay = Date.parse(`${TODAY}T00:00:00.000Z`) + 24 * 3_600_000 - NOW.getTime();
		let finished = false;
		for (let t = 0; t < 120 && !finished; t++) {
			const outcome = leg(
				await tick(cms, cursors, { budget: FREE, offsetMs: nextDay + t * MINUTE_MS }),
			);
			finished =
				outcome.incomplete === undefined && outcome.deferred !== true && outcome.notDue !== true;
		}
		expect(finished).toBe(true);
		for (const id of ids) expect(await row(id), id).toMatchObject({ active: true });
		// Listed once for the whole pass: the capped day never skipped or re-listed a product.
		expect(cms.pageLists).toBe(1);
		const after = await stored(cursors);
		expect(after).toMatchObject({ repairsToday: 2, passStartedAt: null });
		expect(after.day).not.toBe(TODAY);
		expect(errors).toEqual([]);
	});

	test("only a repair's writes count: not its check visit, not a product already in sync, not one its own hook synced first", async () => {
		const cms = new Cms();
		cms.put({ id: "p1", title: "One", updatedAt: T2, createdAt: T3 });
		cms.put({ id: "p2", title: "Two", updatedAt: T2, createdAt: T2 });
		await syncedRow("p3", "Three", T1);
		cms.put({ id: "p3", title: "Three", updatedAt: T1, createdAt: T1 });
		await syncedRow("p4", "Four", T1);
		cms.put({ id: "p4", title: "Four", updatedAt: T1, createdAt: "2026-10-29T08:00:00.000Z" });
		// p4 drifts in the list, and its own publish hook syncs it before the repair reads it.
		cms.put({
			id: "p4",
			title: "Four renamed",
			updatedAt: T2,
			createdAt: "2026-10-29T08:00:00.000Z",
		});
		cms.afterList = async () => {
			await createAfterPublishHandler()(
				{
					collection: "products",
					content: { ...cms.docs.get("p4") },
				} as unknown as ContentStateChangeEvent,
				sweepContext(storage),
			);
		};
		const cursors = memoryCursors();

		const outcome = leg(await tick(cms, cursors));

		expect(outcome).toMatchObject({ ok: true, count: 2 });
		expect(outcome.incomplete).toBeUndefined();
		expect(await stored(cursors)).toMatchObject({ day: TODAY, repairsToday: 2 });
	});

	test("a run the tick's ceiling stops part-way through a repair's writes still keeps the day's count", async () => {
		const today = { day: TODAY, repairsToday: 7 };
		let writes = 0;
		const ceilingOnSecondWrite: StorageAccess = {};
		for (const [name, collection] of Object.entries(storage)) {
			ceilingOnSecondWrite[name] = new Proxy(collection, {
				get(target, prop, receiver) {
					const value: unknown = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						if (["put", "compareAndSet", "updateIf", "createIfAbsent"].includes(String(prop))) {
							writes++;
							if (writes === 2) throw new SweepQueryCeilingError(FREE, "product-reconcile");
						}
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				},
			});
		}
		const doc = {
			id: "p1",
			status: "published",
			updatedAt: T2,
			version: 1,
			data: { title: "Shirt" },
		};
		const base = memoryCursors();
		await base.write(PRODUCT_RECONCILE_CURSOR, JSON.stringify(today));
		const budget = {
			stopped: false,
			gate: () => () => true,
			remainingQueries: () => 1000,
		} as unknown as Parameters<typeof reconcileProductCommerce>[4];

		await expect(
			reconcileProductCommerce(
				sweepContext(ceilingOnSecondWrite),
				{ many: async () => new Map(), one: async () => undefined },
				{
					list: async () => ({ items: [doc], hasMore: false }),
					get: async () => structuredClone(doc),
				},
				base,
				budget,
				{
					now: NOW,
					passIntervalMs: RECONCILE_PASS_INTERVAL_FREE_MS,
					dailyRepairCap: RECONCILE_REPAIRS_PER_DAY_FREE,
				},
			),
		).rejects.toBeInstanceOf(SweepQueryCeilingError);
		expect(writes).toBeGreaterThanOrEqual(2);
		expect(await stored(base)).toMatchObject({ day: TODAY, repairsToday: 8 });
	});
});
