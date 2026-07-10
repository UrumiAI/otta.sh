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
	await admin.query(`CREATE SCHEMA "${schema}"`);

	const pool = makePostgresPool({
		connectionString,
		max: options.poolMax ?? 8,
		options: `-c search_path=${schema}`,
	});
	const db = makePostgresDb(pool);
	await migrateToLatest(db);

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
