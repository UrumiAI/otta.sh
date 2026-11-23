/**
 * Test harness for Otta Core: a PluginContext over EmDash's REAL storage with
 * bridge-call counting and fault injection.
 *
 * - `ctx.storage.<collection>` wraps the host's own PluginStorageRepository
 *   (in-memory better-sqlite3, schema from the host's runMigrations, so the
 *   revision trigger exists) with exactly the closure shape of the host's
 *   createStorageCollection.
 * - Every storage/kv/http/cron method call is ONE bridge call (what crosses the
 *   Worker Loader boundary in production; default limit 30 per invocation).
 *   ctx.log, ctx.site and ctx.url() are free (local in the sandbox).
 * - The context is cast `as unknown as PluginContext` at the boundary: the real
 *   type has many optional capabilities (content, media, settings, ...) the
 *   harness deliberately does not provide, and `storage` is typed
 *   PluginStorage<PluginStorageConfig> with untyped collections.
 *   Core reads settings via kv "settings:*" only; ctx.settings is NOT provided.
 * - `ctx.content` is a read-only in-memory fake (get + list, one bridge call
 *   each) seeded with `content.put`, for the resync route. Nothing else in Core
 *   reads it; hooks still receive their events directly.
 */
import Database from "better-sqlite3";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import type { PluginContext } from "emdash/plugin";
import { createDialect as createPgDialect } from "emdash/db/postgres";
import { Kysely, sql, SqliteDialect } from "kysely";
import { COLLECTIONS } from "../src/model.js";

export type HostDb = Parameters<typeof runMigrations>[0];
const PLUGIN_ID = "otta";

// ── database selection ──
//
// PG_CONNECTION_STRING set: EmDash's own Postgres dialect (emdash/db/postgres,
// `pg` Pool) on a FRESH database per test, cloned from a per-worker template
// that EmDash's runMigrations built (so the revision trigger is the host's).
// A database rather than a schema per test because EmDash's migration lock is
// a database-wide advisory lock. Unset: in-memory better-sqlite3, as before.

/** The connection string, when the Postgres tier is selected. */
export const PG_URL = process.env["PG_CONNECTION_STRING"] || null;
export const DIALECT: "postgres" | "sqlite" = PG_URL ? "postgres" : "sqlite";

/** PG_URL with its database name replaced (URL form: scheme://user@host/db?params). */
function pgUrlFor(database: string): string {
	const m = /^(postgres(?:ql)?:\/\/[^/?]*)(?:\/[^?]*)?(\?.*)?$/.exec(PG_URL!);
	if (!m) throw new Error("PG_CONNECTION_STRING must be a postgres:// URL");
	return `${m[1]}/${database}${m[2] ?? ""}`;
}
const pgOpen = (database: string, max = 4): HostDb =>
	new Kysely({
		dialect: createPgDialect({
			connectionString: pgUrlFor(database),
			pool: { max, idleTimeoutMillis: 1000 },
		}),
	}) as HostDb;

let pgAdmin: HostDb | null = null;
let pgTemplate: Promise<string> | null = null;
const pgName = (kind: string) =>
	`otta_${kind}_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;

/** One migrated template database per worker process. */
function pgTemplateDb(): Promise<string> {
	pgTemplate ??= (async () => {
		pgAdmin ??= pgOpen("postgres", 2);
		const name = pgName("tpl");
		await sql`CREATE DATABASE ${sql.id(name)}`.execute(pgAdmin);
		const db = pgOpen(name, 1);
		try {
			await runMigrations(db);
		} finally {
			await db.destroy(); // a template must have no open connections
		}
		return name;
	})();
	return pgTemplate;
}

export interface TestDb {
	dialect: "postgres" | "sqlite";
	/** The primary Kysely instance. */
	db: HostDb;
	/**
	 * Another Kysely instance on the SAME database with its own connection pool
	 * (Postgres), so concurrent operations really run on separate connections.
	 * SQLite (in-memory) has one connection; it returns the primary instance.
	 */
	connect(max?: number): HostDb;
	/** Destroy every instance and drop the database. */
	drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
	if (!PG_URL) {
		const db = new Kysely({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
		}) as HostDb;
		await runMigrations(db);
		return { dialect: "sqlite", db, connect: () => db, drop: () => db.destroy() };
	}
	const tpl = await pgTemplateDb();
	const name = pgName("t");
	await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE ${sql.id(tpl)}`.execute(pgAdmin!);
	const all: HostDb[] = [];
	const connect = (max = 4) => {
		const d = pgOpen(name, max);
		all.push(d);
		return d;
	};
	const db = connect();
	return {
		dialect: "postgres",
		db,
		connect,
		async drop() {
			await Promise.all(all.splice(0).map((d) => d.destroy()));
			await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(pgAdmin!);
		},
	};
}

export interface Calls {
	total: number;
	byMethod: Record<string, number>;
	/** Method names in call order. */
	sequence: string[];
}

export interface HttpRequestLog {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}
export interface HttpReply {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
	json?: unknown;
}
export type HttpHandler = HttpReply | ((req: HttpRequestLog) => HttpReply | Promise<HttpReply>);

export interface FakeHttp {
	/** Register by method ("*" = any) and URL prefix; longest prefix wins, later wins ties. */
	on(method: string, urlPrefix: string, handler: HttpHandler): void;
	requests: HttpRequestLog[];
	clear(): void;
}
export interface FakeKv {
	/** Seed `settings:<name>` entries without counting a bridge call. */
	seedSettings(settings: Record<string, unknown>): void;
	/** Uncounted read of the raw map. */
	dump(): Record<string, unknown>;
}
/** A content item as EmDash 1.5's plugin ContentAccess returns it (the live table columns). */
export interface FakeContentItem {
	id: string;
	status: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	liveRevisionId?: string | null;
	draftRevisionId?: string | null;
	[k: string]: unknown;
}
export interface FakeContent {
	/** Uncounted: create or replace an item (what ctx.content.get/list will return). */
	put(collection: string, item: FakeContentItem): void;
	/** Uncounted: remove an item (deleted or trashed: get returns null, list skips it). */
	remove(collection: string, id: string): void;
}
export interface FakeCron {
	scheduled: Array<{ name: string; schedule: string; data?: Record<string, unknown> }>;
	canceled: string[];
}

export interface TestContextOptions {
	/** Override COLLECTIONS indexes (default: from src/model.ts). */
	collections?: Record<string, { indexes: ReadonlyArray<string | readonly string[]> }>;
	/**
	 * An already-migrated database to share (e.g. `TestDb.connect()` for a second,
	 * concurrently running context). The caller owns it: close() leaves it open.
	 * Default: a fresh database of the selected dialect, dropped by close().
	 */
	db?: HostDb;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const desc = (a: FakeContentItem, b: FakeContentItem) =>
	a.createdAt !== b.createdAt
		? a.createdAt < b.createdAt
			? 1
			: -1
		: a.id < b.id
			? 1
			: a.id > b.id
				? -1
				: 0;

export async function createTestContext(opts: TestContextOptions = {}) {
	const own = opts.db ? null : await createTestDb();
	const db = opts.db ?? own!.db;

	let total = 0;
	let byMethod: Record<string, number> = {};
	let sequence: string[] = [];
	let failN: number | null = null;
	let failAfter = false;
	/** compareAndSet calls that returned {applied:false} (real or injected), per collection. */
	const casLost: Record<string, number> = {};
	const races: Array<{ collection: string; id: string; rival?: unknown }> = [];

	const resetCalls = () => {
		total = 0;
		byMethod = {};
		sequence = [];
	};
	const calls = (): Calls => ({ total, byMethod: { ...byMethod }, sequence: [...sequence] });
	/** Wrap one bridge method: count, maybe crash before/after the effect. */
	async function bridge<R>(name: string, run: () => Promise<R>): Promise<R> {
		total++;
		byMethod[name] = (byMethod[name] ?? 0) + 1;
		sequence.push(name);
		const doomed = failN === total;
		if (doomed) failN = null;
		if (doomed && !failAfter)
			throw new Error(`injected failure at bridge call #${total} (${name})`);
		const r = await run();
		if (doomed) throw new Error(`injected failure after bridge call #${total} (${name})`);
		return r;
	}

	// ── storage ──
	const layout = opts.collections ?? COLLECTIONS;
	const raw: Record<string, PluginStorageRepository> = {};
	const storage: Record<string, unknown> = {};
	for (const [name, cfg] of Object.entries(layout)) {
		const repo = new PluginStorageRepository(db, PLUGIN_ID, name, [
			...(cfg.indexes as Array<string | string[]>),
		]);
		raw[name] = repo;
		const m =
			<A extends unknown[], R>(method: string, fn: (...a: A) => Promise<R>) =>
			(...a: A) =>
				bridge(`storage.${name}.${method}`, () => fn(...a));
		storage[name] = {
			get: m("get", (id: string) => repo.get(id)),
			getVersioned: m("getVersioned", (id: string) => repo.getVersioned(id)),
			compareAndSet: (id: string, expected: string | null, data: unknown) =>
				bridge(`storage.${name}.compareAndSet`, async () => {
					const i = races.findIndex((r) => r.collection === name && r.id === id);
					if (i >= 0) {
						const [race] = races.splice(i, 1);
						// A rival wrote first: bump the revision (or write their doc), then the REAL CAS runs and loses.
						const cur = await repo.get(id);
						const rival = race!.rival ?? cur;
						if (rival !== null && rival !== undefined) await repo.put(id, rival);
						else {
							casLost[name] = (casLost[name] ?? 0) + 1;
							return { applied: false as const };
						}
					}
					const r = await repo.compareAndSet(id, expected, data);
					if (!r.applied) casLost[name] = (casLost[name] ?? 0) + 1;
					return r;
				}),
			compareAndDelete: m("compareAndDelete", (id: string, rev: string) =>
				repo.compareAndDelete(id, rev),
			),
			put: m("put", (id: string, data: unknown) => repo.put(id, data)),
			delete: m("delete", (id: string) => repo.delete(id)),
			exists: m("exists", (id: string) => repo.exists(id)),
			getMany: m("getMany", (ids: string[]) => repo.getMany(ids)),
			putMany: m("putMany", (items: Array<{ id: string; data: unknown }>) => repo.putMany(items)),
			deleteMany: m("deleteMany", (ids: string[]) => repo.deleteMany(ids)),
			count: m("count", (where?: Record<string, never>) => repo.count(where)),
			updateIf: m(
				"updateIf",
				(id: string, args: Parameters<PluginStorageRepository["updateIf"]>[1]) =>
					repo.updateIf(id, args),
			),
			async query(options?: { where?: never; orderBy?: never; limit?: number; cursor?: string }) {
				return bridge(`storage.${name}.query`, async () => {
					const r = await repo.query({
						where: options?.where,
						orderBy: options?.orderBy,
						limit: options?.limit,
						cursor: options?.cursor,
					});
					return { items: r.items, cursor: r.cursor, hasMore: r.hasMore };
				});
			},
		};
	}

	// ── kv ──
	const kvMap = new Map<string, { value: unknown; rev: number }>();
	let revSeq = 0;
	const kvApi = {
		get: (key: string) =>
			bridge("kv.get", async () => (kvMap.has(key) ? clone(kvMap.get(key)!.value) : null)),
		getVersioned: (key: string) =>
			bridge("kv.getVersioned", async () => {
				const e = kvMap.get(key);
				return e ? { value: clone(e.value), revision: String(e.rev) } : null;
			}),
		set: (key: string, value: unknown) =>
			bridge("kv.set", async () => void kvMap.set(key, { value: clone(value), rev: ++revSeq })),
		delete: (key: string) => bridge("kv.delete", async () => kvMap.delete(key)),
		list: (prefix = "") =>
			bridge("kv.list", async () =>
				[...kvMap.entries()]
					.filter(([k]) => k.startsWith(prefix))
					.map(([key, e]) => ({ key, value: clone(e.value) })),
			),
		compareAndSet: (key: string, expected: string | null, value: unknown) =>
			bridge("kv.compareAndSet", async () => {
				const e = kvMap.get(key);
				if ((expected === null && e) || (expected !== null && (!e || String(e.rev) !== expected)))
					return { applied: false as const };
				const rev = ++revSeq;
				kvMap.set(key, { value: clone(value), rev });
				return { applied: true as const, revision: String(rev) };
			}),
		compareAndDelete: (key: string, expected: string) =>
			bridge("kv.compareAndDelete", async () => {
				const e = kvMap.get(key);
				if (!e || String(e.rev) !== expected) return { applied: false };
				kvMap.delete(key);
				return { applied: true };
			}),
	};
	const kv: FakeKv = {
		seedSettings(s) {
			for (const [k, v] of Object.entries(s))
				kvMap.set(`settings:${k}`, { value: clone(v), rev: ++revSeq });
		},
		dump: () => Object.fromEntries([...kvMap].map(([k, e]) => [k, e.value])),
	};

	// ── http ──
	const handlers: Array<{ method: string; prefix: string; handler: HttpHandler }> = [];
	const requests: HttpRequestLog[] = [];
	const http: FakeHttp = {
		on: (method, prefix, handler) =>
			void handlers.push({ method: method.toUpperCase(), prefix, handler }),
		requests,
		clear: () => void (requests.length = 0),
	};
	const httpApi = {
		fetch: (url: string, init?: RequestInit) =>
			bridge("http.fetch", async () => {
				const method = (init?.method ?? "GET").toUpperCase();
				const headers: Record<string, string> = {};
				new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
				const b = init?.body;
				const body =
					b == null
						? ""
						: typeof b === "string"
							? b
							: b instanceof Uint8Array
								? new TextDecoder().decode(b)
								: String(b);
				const req: HttpRequestLog = { url, method, headers, body };
				requests.push(req);
				let best: (typeof handlers)[number] | undefined;
				for (const h of handlers)
					if (
						(h.method === "*" || h.method === method) &&
						url.startsWith(h.prefix) &&
						(!best || h.prefix.length >= best.prefix.length)
					)
						best = h;
				if (!best) throw new Error(`no fake http handler for ${method} ${url}`);
				const reply = typeof best.handler === "function" ? await best.handler(req) : best.handler;
				const status = reply.status ?? 200;
				const text = reply.body ?? (reply.json !== undefined ? JSON.stringify(reply.json) : "");
				const rh = new Headers(reply.headers);
				if (reply.json !== undefined && !rh.has("content-type"))
					rh.set("content-type", "application/json");
				return {
					status,
					ok: status >= 200 && status < 300,
					headers: rh,
					text: async () => text,
					json: async () => JSON.parse(text) as unknown,
				} as unknown as Response;
			}),
	};

	// ── content (read-only, like the content:read capability) ──
	// Same paging as EmDash's ContentRepository.findMany: createdAt desc, id desc,
	// keyset cursor, limit default 50 clamped to 1..100.
	const contentMap = new Map<string, Map<string, FakeContentItem>>();
	const contentOf = (c: string) => contentMap.get(c) ?? contentMap.set(c, new Map()).get(c)!;
	const content: FakeContent = {
		put: (c, item) => void contentOf(c).set(item.id, clone(item)),
		remove: (c, id) => void contentOf(c).delete(id),
	};
	const contentApi = {
		get: (c: string, id: string) =>
			bridge("content.get", async () => clone(contentOf(c).get(id) ?? null)),
		list: (c: string, o: { limit?: number; cursor?: string; where?: { status?: string } } = {}) =>
			bridge("content.list", async () => {
				const limit = Math.max(1, Math.min(o.limit ?? 50, 100));
				let all = [...contentOf(c).values()].toSorted(desc);
				if (o.where?.status) all = all.filter((i) => i.status === o.where!.status);
				if (o.cursor) {
					const k = JSON.parse(o.cursor) as { createdAt: string; id: string };
					all = all.filter((i) => desc(i, { ...i, createdAt: k.createdAt, id: k.id }) > 0);
				}
				const items = all.slice(0, limit).map(clone);
				const last = items.at(-1);
				const hasMore = all.length > limit;
				return {
					items,
					hasMore,
					...(hasMore && last
						? { cursor: JSON.stringify({ createdAt: last.createdAt, id: last.id }) }
						: {}),
				};
			}),
	};

	// ── cron ──
	const cron: FakeCron = { scheduled: [], canceled: [] };
	const cronApi = {
		schedule: (name: string, o: { schedule: string; data?: Record<string, unknown> }) =>
			bridge("cron.schedule", async () => void cron.scheduled.push({ name, ...o })),
		cancel: (name: string) => bridge("cron.cancel", async () => void cron.canceled.push(name)),
		list: () => bridge("cron.list", async () => []),
	};

	const logs: Array<{ level: string; message: string; data?: unknown }> = [];
	const log = Object.fromEntries(
		(["debug", "info", "warn", "error"] as const).map((level) => [
			level,
			(message: string, data?: unknown) => void logs.push({ level, message, data }),
		]),
	);
	const site = { name: "Test", url: "https://shop.test", locale: "en" };

	const ctx = {
		plugin: { id: PLUGIN_ID, version: "0.0.0" },
		storage,
		kv: kvApi,
		http: httpApi,
		cron: cronApi,
		content: contentApi,
		log,
		site,
		url: (path: string) => new URL(path, site.url).toString(),
	} as unknown as PluginContext;

	return {
		ctx,
		calls,
		resetCalls,
		http,
		kv,
		cron,
		content,
		logs,
		db,
		dialect: DIALECT,
		/** Lost compareAndSet calls per collection since the context was created. */
		casLost: () => ({ ...casLost }),
		/** Uncounted direct repository access, for seeding and assertions. */
		raw: (collection: string) => raw[collection]!,
		/** Make the Nth bridge call (1-based, since the last resetCalls) throw. `after: true` applies the effect first. */
		failAt(n: number | null, o: { after?: boolean } = {}) {
			failN = n === null ? null : total + n;
			failAfter = o.after === true;
		},
		/**
		 * The next compareAndSet on collection/id loses a race: a rival write lands first
		 * (their `rival` doc, or the current doc rewritten) so the revision moves and the
		 * REAL CAS returns {applied:false}. If the row is absent and no rival is given,
		 * it returns {applied:false} without writing.
		 */
		raceOnce(collection: string, id: string, rival?: unknown) {
			races.push({ collection, id, rival });
		},
		async close() {
			if (own) await own.drop();
		},
	};
}
