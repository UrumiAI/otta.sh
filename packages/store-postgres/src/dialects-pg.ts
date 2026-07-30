import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./schema.js";

/**
 * Postgres dialect factories (§0.4) — split from the sqlite factory so a
 * bundler-targeted entry (`@otta-sh/store-postgres/pg`, used by the Cloudflare
 * Worker) can reach pg/Kysely without dragging in the `better-sqlite3` native
 * addon, which workerd/esbuild cannot bundle.
 */

/** Build a pg Pool. `max` must be ≥ N for the no-oversell test's N racing reserves. */
export function makePostgresPool(config: PoolConfig): Pool {
	return new Pool(config);
}

export function makePostgresDb(pool: Pool): Kysely<Database> {
	return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
