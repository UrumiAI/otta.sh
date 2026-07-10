import type { Kysely } from "kysely";
import { makePostgresDb, makePostgresPool } from "./dialects.js";
import { migrateToLatest } from "./migrations/index.js";
import type { Database } from "./schema.js";

export interface IsolatedPgSchema {
	db: Kysely<Database>;
	schema: string;
	/** Close the pools and drop the schema. */
	teardown(): Promise<void>;
}

export interface IsolatedPgSchemaOptions {
	/** Pool size — must be ≥ N for N concurrent reserves on independent conns. */
	poolMax?: number;
}

/**
 * Per-test Postgres isolation (§8 R7), shared by every pg-backed test
 * (no-oversell, the dialect contract harness, the live-server helper):
 * `CREATE SCHEMA test_<rand>` + a pool whose every connection is pinned to it
 * via `search_path`, migrated to latest; the schema is dropped and the pools
 * closed on `teardown`.
 */
export async function createIsolatedPgSchema(
	connectionString: string,
	options: IsolatedPgSchemaOptions = {},
): Promise<IsolatedPgSchema> {
	const schema = `test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

	const admin = makePostgresPool({ connectionString, max: 1 });
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`);
	} catch (err) {
		await admin.end().catch(() => {});
		throw err;
	}

	const pool = makePostgresPool({
		connectionString,
		max: options.poolMax ?? 8,
		options: `-c search_path=${schema}`,
	});
	const db = makePostgresDb(pool);
	try {
		// Scoped to THIS schema: without `migrationTableSchema` the Migrator's
		// existence check can match another live test schema's tables and fail —
		// the concurrent-schema flake (see MigrateToLatestOptions). Retried: the Migrator's
		// existence check introspects EVERY table in the database, so it can trip
		// over a peer test's `DROP SCHEMA … CASCADE` mid-scan (a transient pg
		// catalog race). The schema is brand new and empty, so re-running the
		// migration is safe.
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await migrateToLatest(db, { migrationTableSchema: schema });
				lastError = undefined;
				break;
			} catch (err) {
				lastError = err;
				await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
			}
		}
		if (lastError !== undefined) throw lastError;
	} catch (err) {
		// Setup failure must not leak the pool (connection exhaustion for every
		// later test) or the schema (test_* litter in the shared test database).
		await db.destroy().catch(() => {});
		await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
		await admin.end().catch(() => {});
		throw err;
	}

	return {
		db,
		schema,
		async teardown() {
			await db.destroy();
			await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
			await admin.end();
		},
	};
}
