import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-1 forward-only migration (plan §4/§6 step 4): `product_commerce`, one
 * row per product, keyed by the CMS content id (`product_id`). Portable
 * types only (text/integer) so identical DDL emits for both dialects —
 * mirrors 0001's style. Never edit a shipped migration; correct forward with
 * 0003+ (reserved for later phases). (This migration is amended in place
 * pre-merge — it has never shipped.)
 *
 * `sku` and `price_*` are NULLABLE — "create then price" (plan §1 case 3):
 * `content:afterSave` may upsert a bare row (product_id only) before any
 * commercial data is ever entered. `idempotency_key` is per-row, mutable,
 * NOT unique (plan §4 — distinct from Phase 0's `reservations`, which is a
 * global UNIQUE claim table).
 *
 * `sku` uniqueness is a PARTIAL unique index over LIVE rows only
 * (`WHERE deleted_at IS NULL`, supported identically on Postgres and
 * SQLite) — a hard UNIQUE would permanently lock a soft-deleted product's
 * SKU against reuse (review S3; delete-and-recreate is a normal merchant
 * flow), while the tombstoned row still retains its sku for order-history
 * integrity. The upsert's `ON CONFLICT` target remains the `product_id` PK,
 * so the partial index never participates in conflict arbitration — it only
 * enforces live-sku uniqueness (a violating write errors, on both dialects).
 *
 * `content_updated_at` is the sync-ordering watermark (review S1): the CMS
 * content's own `updatedAt` last applied by a `content:afterSave` sync.
 * Stored as ISO-8601 text, so lexicographic comparison is chronological —
 * the store's upsert guard uses it to make a strictly-older (out-of-order /
 * delayed) sync a no-op. Null until a sync ever carries one; panel saves
 * preserve it.
 *
 * `active` is stored as portable `integer` 0/1, not a SQL `boolean` —
 * better-sqlite3 cannot bind a JS `boolean`, and Phase 0 already established
 * "portable types only (text/integer)" across both dialects (schema.ts).
 */
export const migration0002ProductCommerce: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("product_commerce")
			.addColumn("product_id", "text", (col) => col.primaryKey())
			.addColumn("sku", "text")
			.addColumn("price_cents", "integer", (col) => col.check(sql`price_cents >= 0`))
			.addColumn("price_currency", "text")
			.addColumn("tax_class", "text")
			.addColumn("weight_grams", "integer")
			.addColumn("length_mm", "integer")
			.addColumn("width_mm", "integer")
			.addColumn("height_mm", "integer")
			.addColumn("product_kind", "text", (col) => col.notNull())
			.addColumn("active", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("deleted_at", "text")
			.addColumn("idempotency_key", "text", (col) => col.notNull())
			.addColumn("content_updated_at", "text")
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			.execute();

		// Live-rows-only sku uniqueness (see the header comment). Raw predicate:
		// Kysely's index builder only offers indexed columns to `where`'s typed
		// overload, and the partial-index predicate is over `deleted_at`.
		await db.schema
			.createIndex("product_commerce_live_sku_unique")
			.on("product_commerce")
			.column("sku")
			.unique()
			.where(sql<boolean>`deleted_at is null`)
			.execute();
	},
};
