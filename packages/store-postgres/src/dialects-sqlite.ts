import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.js";

/**
 * better-sqlite3 dialect factory (§0.4) — the fast/local default. Kept in its
 * own module so sqlite-free entries (`./pg`) never import the native addon.
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
