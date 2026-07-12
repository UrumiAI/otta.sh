import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the admin Orders console list (view-only). Adds a
 * composite index on `orders(created_at, id)` — the exact keyset order the admin
 * list paginates on (`ORDER BY created_at DESC, id DESC` with a
 * `(created_at, id)` cursor predicate). Cheap insurance against a full scan as
 * order volume grows, not a performance target.
 *
 * Up-only, matching every prior migration (CLAUDE.md: migrations are
 * forward-only). `ifNotExists` mirrors `0008`'s builder style so a re-run is a
 * no-op, and the identical portable DDL emits for better-sqlite3 and pg.
 */
export const migration0009OrdersAdminListIndices: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createIndex("idx_orders_created_id")
			.ifNotExists()
			.on("orders")
			.columns(["created_at", "id"])
			.execute();
	},
};
