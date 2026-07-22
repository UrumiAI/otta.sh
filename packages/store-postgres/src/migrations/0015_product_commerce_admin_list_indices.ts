import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the admin Products console list (view-only,
 * admin-UX Increment 2). Adds a composite index on
 * `product_commerce(created_at, product_id)` — the exact keyset order the
 * admin list paginates on (`ORDER BY created_at DESC, product_id DESC` with a
 * `(created_at, product_id)` cursor predicate), mirroring `0009`'s
 * `orders(created_at, id)` index for the identical reason. Cheap insurance
 * against a full scan as catalog size grows, not a performance target.
 *
 * Up-only, matching every prior migration (CLAUDE.md: migrations are
 * forward-only). `ifNotExists` mirrors `0009`'s builder style so a re-run is a
 * no-op, and the identical portable DDL emits for better-sqlite3 and pg.
 */
export const migration0015ProductCommerceAdminListIndices: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createIndex("idx_product_commerce_created_id")
			.ifNotExists()
			.on("product_commerce")
			.columns(["created_at", "product_id"])
			.execute();
	},
};
