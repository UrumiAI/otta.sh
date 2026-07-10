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
	const database = new BetterSqlite3(path);
	// Postgres enforces FKs natively; better-sqlite3 does NOT unless this pragma
	// is set per connection (it uses a single connection, so this covers all).
	database.pragma("foreign_keys = ON");
	return new Kysely<Database>({
		dialect: new SqliteDialect({ database }),
	});
}

/** Build a pg Pool. `max` must be ≥ N for the no-oversell test's N racing reserves. */
export function makePostgresPool(config: PoolConfig): Pool {
	return new Pool(config);
}

export function makePostgresDb(pool: Pool): Kysely<Database> {
	return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
