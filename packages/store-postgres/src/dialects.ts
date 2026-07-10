import BetterSqlite3 from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./schema.js";

/**
 * Dialect factories (§0.4). One Kysely store runs over both — better-sqlite3
 * (fast/local default) and pg (CI/prod) — so the same code and the same
 * contract suite exercise both.
 */

export function makeSqliteDb(path = ":memory:"): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new SqliteDialect({ database: new BetterSqlite3(path) }),
	});
}

/** Build a pg Pool. `max` must be ≥ N for the no-oversell test's N racing reserves. */
export function makePostgresPool(config: PoolConfig): Pool {
	return new Pool(config);
}

export function makePostgresDb(pool: Pool): Kysely<Database> {
	return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
