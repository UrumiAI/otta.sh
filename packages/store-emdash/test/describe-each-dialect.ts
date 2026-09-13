/**
 * The dialect harness for `@otta-sh/store-emdash`.
 *
 * It builds a `StorageAccess` out of **real `PluginStorageRepository` instances**
 * — the host's own class, from the root `emdash` entry — over two dialects:
 * in-memory better-sqlite3 (the fast local default) and Postgres when
 * `PG_CONNECTION_STRING` is set (the only tier that can actually race).
 *
 * Three rules are load-bearing:
 *
 * 1. **The schema always comes from `runMigrations(db)`, never a hand-built
 *    table.** Revisions are assigned by a trigger created by the conditional-write
 *    migration; a hand-created `_plugin_storage` has no trigger, so every
 *    `compareAndSet` would see an unchanging revision and quietly agree with
 *    itself. The full migration set runs because that migration's `up()` is not
 *    individually exported.
 * 2. **The database is per FILE, and rows are cleared per TEST.** The migration
 *    set is 77 migrations — a database per test cost ~2.5s per case on Postgres
 *    and bought nothing. Isolation between cases comes from emptying the storage
 *    table, which is also the only form of reset that KEEPS the trigger rule (1)
 *    depends on; dropping and recreating the table would silently remove it.
 *    Files stay isolated from each other by their own schema, and Postgres runs
 *    test files serially (see `vitest.config.ts`).
 * 3. **Each collection gets the declared `indexes` *and* `uniqueIndexes` as its
 *    constructor argument**, exactly as the host's own `createStorageAccess`
 *    does. The host's index-materializing function
 *    (`syncDeclaredStorageIndexes`) is internal to the build and not exported,
 *    so the constructor argument is the whole of the declaration here: it is the
 *    queryable-field allow-list, and NO physical index — unique or otherwise —
 *    exists in either tier. Uniqueness is therefore never enforced in these
 *    suites, and no adapter may depend on it being (see this package's README).
 *
 * This file lives in `test/`, outside the sandbox perimeter: it runs in Node and
 * may import the host, `kysely`, `pg` and `better-sqlite3`. Nothing in `src/`
 * may.
 */
import type { StorageAccess, StorageCollection } from "../src/index.js";
import { collectionOf } from "../src/index.js";
import Database from "better-sqlite3";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, PostgresDialect, sql, SqliteDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

/** Postgres runs only when the connection string is present (DEVELOPMENT.md §2). */
export const PG_ENABLED = process.env.PG_CONNECTION_STRING !== undefined;

/** The plugin id every harness collection is namespaced under. */
const PLUGIN_ID = "otta";

/** The one table the repositories write. Emptied between cases, never dropped. */
const STORAGE_TABLE = "_plugin_storage";

/** One collection as the plugin descriptor declares it (D3's index rule). */
export interface CollectionLayout {
	indexes?: Array<string | string[]>;
	uniqueIndexes?: Array<string | string[]>;
}

/** The declared storage layout: collection name → its declared indexes. */
export type StorageLayout = Record<string, CollectionLayout>;

/** The schema is the host's — name its own database type rather than restate it. */
type HostDb = Parameters<typeof runMigrations>[0];

/** One migrated database, its collections, and how to empty and close it. */
interface DialectDb {
	storage: StorageAccess;
	/** Empty the storage table, keeping the schema (and its triggers) intact. */
	reset(): Promise<void>;
	close(): Promise<void>;
}

/** What a suite reads its collections out of, after the file's `beforeAll`. */
export interface DialectStorage {
	/** The injected `StorageAccess`, keyed exactly as the layout was. */
	readonly storage: StorageAccess;
	/** One collection, typed to the document it holds. */
	collection<T>(name: string): StorageCollection<T>;
}

/** Build the collections the way the host builds `ctx.storage`. */
function buildStorage(db: HostDb, layout: StorageLayout): StorageAccess {
	const storage: StorageAccess = {};
	for (const [name, config] of Object.entries(layout)) {
		// Exactly the argument the host passes: declared indexes AND unique
		// indexes are both queryable fields.
		const indexes = [...(config.indexes ?? []), ...(config.uniqueIndexes ?? [])];
		storage[name] = new PluginStorageRepository(db, PLUGIN_ID, name, indexes);
	}
	return storage;
}

/** Fresh in-memory SQLite, migrated to latest. */
export async function makeSqliteStorage(layout: StorageLayout): Promise<DialectDb> {
	const db = new Kysely({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
	}) as HostDb;
	await runMigrations(db);
	return {
		storage: buildStorage(db, layout),
		async reset() {
			// SQLite has no TRUNCATE; the DELETE leaves the revision triggers in place.
			await sql.raw(`DELETE FROM ${STORAGE_TABLE}`).execute(db);
		},
		async close() {
			await db.destroy();
		},
	};
}

/**
 * Fresh, isolated Postgres schema: `CREATE SCHEMA test_<rand>` plus a pool whose
 * every connection is pinned to it via `search_path`, migrated to latest inside
 * it. One per test FILE; cases are isolated by `reset()`.
 */
export async function makePgStorage(layout: StorageLayout, poolMax = 12): Promise<DialectDb> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const schema = `test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

	const admin = new pg.Pool({ connectionString, max: 1 });
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`);
	} catch (err) {
		await admin.end().catch(() => {});
		throw err;
	}

	const pool = new pg.Pool({
		connectionString,
		max: poolMax,
		options: `-c search_path=${schema}`,
	});
	const db = new Kysely({ dialect: new PostgresDialect({ pool }) }) as HostDb;
	const close = async (): Promise<void> => {
		// Guarded: a rejecting destroy() must not leak the admin pool (connection
		// exhaustion for every later file) or the schema (test_* litter in a shared
		// database). Both cleanups run regardless, and the first failure surfaces.
		try {
			await db.destroy();
		} finally {
			try {
				await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
			} finally {
				await admin.end();
			}
		}
	};

	try {
		// Scoped to THIS schema, or the host's runner short-circuits on a migration
		// count read from whatever schema it can see. Retried three times, copied
		// from the sibling package's helper for the reason recorded there: the
		// Migrator's existence check introspects EVERY table in the database, so it
		// can trip over a peer test's `DROP SCHEMA … CASCADE` mid-scan. The schema
		// is brand new and empty, so re-running the migration is safe.
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await runMigrations(db, { migrationTableSchema: schema });
				lastError = undefined;
				break;
			} catch (err) {
				lastError = err;
				await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
			}
		}
		if (lastError !== undefined) throw lastError;
	} catch (err) {
		await close().catch(() => {});
		throw err;
	}

	return {
		storage: buildStorage(db, layout),
		async reset() {
			// TRUNCATE, not DROP: the 077 revision trigger lives on this table and
			// must survive every reset, or `compareAndSet` stops meaning anything.
			await sql.raw(`TRUNCATE TABLE ${STORAGE_TABLE}`).execute(db);
		},
		close,
	};
}

/** What a suite body is handed: how to bind storage, and which dialect it is on. */
export interface DialectContext {
	dialect: "sqlite" | "postgres";
	/** True only on the tier that can exercise a real race. */
	canRace: boolean;
	/**
	 * Call once at the top of the suite body. It registers the file's `beforeAll`
	 * (schema + migrations), a `beforeEach` that empties the storage table, and an
	 * `afterAll` that tears the database down.
	 */
	useStorage(layout: StorageLayout): DialectStorage;
}

function makeContext(dialect: "sqlite" | "postgres"): DialectContext {
	return {
		dialect,
		canRace: dialect === "postgres",
		useStorage(layout) {
			let db: DialectDb | undefined;

			beforeAll(async () => {
				db = dialect === "sqlite" ? await makeSqliteStorage(layout) : await makePgStorage(layout);
			}, 120_000);

			beforeEach(async () => {
				await db?.reset();
			});

			afterAll(async () => {
				const open = db;
				db = undefined;
				await open?.close();
			});

			const current = (): DialectDb => {
				if (db === undefined) throw new Error("storage is only available inside a test");
				return db;
			};
			return {
				get storage() {
					return current().storage;
				},
				collection<T>(name: string): StorageCollection<T> {
					return collectionOf<T>(current().storage, name);
				},
			};
		},
	};
}

/**
 * Run one suite body against every available dialect. Postgres is reported as a
 * visibly skipped suite — naming the missing env var — rather than silently
 * absent, matching `@otta-sh/store-postgres`'s convention that a pg tier which
 * did not run says so.
 */
export function describeEachDialect(name: string, fn: (ctx: DialectContext) => void): void {
	describe(`${name} [sqlite]`, () => {
		fn(makeContext("sqlite"));
	});

	const pgSuite = `${name} [postgres]`;
	if (PG_ENABLED) {
		describe(pgSuite, () => {
			fn(makeContext("postgres"));
		});
	} else {
		describe.skip(`${pgSuite} — skipped: PG_CONNECTION_STRING is not set`, () => {
			fn(makeContext("postgres"));
		});
	}
}
