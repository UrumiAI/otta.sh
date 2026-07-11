/**
 * Dialect factories (§0.4). One Kysely store runs over both — better-sqlite3
 * (fast/local default) and pg (CI/prod) — so the same code and the same
 * contract suite exercise both.
 *
 * Re-export shim: the implementations live in `dialects-pg.ts` /
 * `dialects-sqlite.ts` so the sqlite-free `./pg` entry (Cloudflare Worker)
 * never touches the better-sqlite3 native addon. This module keeps the
 * original combined API for Node consumers and tests.
 */
export { makePostgresDb, makePostgresPool } from "./dialects-pg.js";
export { makeSqliteDb } from "./dialects-sqlite.js";
