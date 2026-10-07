/**
 * The **D1** harness for `@otta-sh/store-emdash` — tier T3.
 *
 * It is the sibling of `test/describe-each-dialect.ts`, not an extension of it,
 * and the split is structural rather than stylistic: this file runs INSIDE
 * `workerd`, where `better-sqlite3`, `pg` and `node:fs` do not exist. The Node
 * harness imports both drivers at module scope, so importing it here would fail
 * before a single case ran. What the two share is the part that matters — the
 * collection layout (`test/inventory-collections.ts`) and the contract wiring the
 * suites do themselves.
 *
 * What this tier is for: D1 is the dialect Otta actually ships on, and it is the
 * only tier that exercises the host's OWN Kysely wiring — `createDialect` from
 * `@emdash-cms/cloudflare/db/d1`, reading the `DB` binding out of
 * `cloudflare:workers`, which is precisely what a deployed site does. The Node
 * tiers construct Otta's own dialects instead.
 *
 * Three rules carry over from the Node harness unchanged, for the same reasons:
 *
 * 1. **The schema always comes from `runMigrations(db)`.** Revisions are assigned
 *    by triggers the conditional-write migration creates — on the SQLite branch,
 *    an `AFTER INSERT` and an `AFTER UPDATE` trigger per table that stamp
 *    `lower(hex(randomblob(16)))`. A hand-created `_plugin_storage` has no
 *    triggers, so every `compareAndSet` would see an unchanging revision and
 *    quietly agree with itself. (Upstream's own D1 suites DO hand-create the
 *    table and then apply migration 077 to it; this harness runs the whole set,
 *    which is what a real site's database has been through.)
 * 2. **The database is per FILE, and rows are cleared per TEST.** The pool gives
 *    each test file its own D1 database and keeps its contents for the file's
 *    lifetime. Isolation between cases comes from emptying the storage table —
 *    the only reset that KEEPS the triggers rule (1) depends on.
 * 3. **Each collection gets the declared `indexes` *and* `uniqueIndexes` as its
 *    constructor argument**, exactly as the host's own `createStorageAccess`
 *    does. No physical index is created in any tier, so uniqueness is never
 *    enforced here and no adapter may depend on it being.
 *
 * The one thing this tier CANNOT do is race: miniflare runs the test file in a
 * single `workerd` isolate on a single thread, so concurrent promises interleave
 * at `await` points but no two statements ever execute at the same instant. See
 * `no-oversell.d1.spec.ts` for what that does and does not prove.
 */
import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { StorageAccess, StorageCollection } from "../../src/index.js";
import { collectionOf } from "../../src/index.js";

/** The binding name the D1 vitest config declares. */
const BINDING = "DB";

/** The plugin id every harness collection is namespaced under. */
const PLUGIN_ID = "otta";

/** The one table the repositories write. Emptied between cases, never dropped. */
const STORAGE_TABLE = "_plugin_storage";

/**
 * One collection as the plugin descriptor declares it.
 *
 * Structurally identical to the Node harness's `CollectionLayout` on purpose:
 * `test/inventory-collections.ts` is typed against that one and is consumed here
 * without a cast.
 */
export interface CollectionLayout {
	indexes?: Array<string | string[]>;
	uniqueIndexes?: Array<string | string[]>;
}

/** The declared storage layout: collection name → its declared indexes. */
export type StorageLayout = Record<string, CollectionLayout>;

/** The schema is the host's — name its own database type rather than restate it. */
type HostDb = Parameters<typeof runMigrations>[0];

/** What a suite reads its collections out of, after the file's `beforeAll`. */
export interface D1Storage {
	/** The injected `StorageAccess`, keyed exactly as the layout was. */
	readonly storage: StorageAccess;
	/** One collection, typed to the document it holds. */
	collection<T>(name: string): StorageCollection<T>;
	/** The migrated Kysely instance, for the schema-level assertions. */
	readonly db: HostDb;
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

/**
 * Open the file's D1 database through the host's own dialect and migrate it.
 *
 * Exported so the race file can build its own instance without the per-test
 * `DELETE` a shared binding would impose on it.
 */
export async function openD1(layout: StorageLayout): Promise<{
	db: HostDb;
	storage: StorageAccess;
	reset(): Promise<void>;
	close(): Promise<void>;
}> {
	const db = new Kysely({ dialect: createDialect({ binding: BINDING }) }) as HostDb;
	await runMigrations(db);
	return {
		db,
		storage: buildStorage(db, layout),
		async reset() {
			// D1 has no TRUNCATE; the DELETE leaves the revision triggers in place.
			await sql.raw(`DELETE FROM ${STORAGE_TABLE}`).execute(db);
		},
		async close() {
			await db.destroy();
		},
	};
}

/**
 * Call once at the top of a suite file. Registers the `beforeAll` that migrates
 * the binding, a `beforeEach` that empties the storage table, and an `afterAll`
 * that closes the Kysely instance.
 */
export function useD1Storage(layout: StorageLayout): D1Storage {
	let open: Awaited<ReturnType<typeof openD1>> | undefined;

	beforeAll(async () => {
		open = await openD1(layout);
	});

	beforeEach(async () => {
		await open?.reset();
	});

	afterAll(async () => {
		const held = open;
		open = undefined;
		await held?.close();
	});

	const current = (): NonNullable<typeof open> => {
		if (open === undefined) throw new Error("storage is only available inside a test");
		return open;
	};
	return {
		get storage() {
			return current().storage;
		},
		get db() {
			return current().db;
		},
		collection<T>(name: string): StorageCollection<T> {
			return collectionOf<T>(current().storage, name);
		},
	};
}
