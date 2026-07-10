import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-1 forward-only migration (plan §4/§6 step 4): `product_commerce`, one
 * row per product, keyed by the CMS content id (`product_id`). Portable
 * types only (text/integer/boolean) so identical DDL emits for both
 * dialects — mirrors 0001's style. Never edit a shipped migration; correct
 * forward with 0003+ (reserved for later phases).
 *
 * `sku` and `price_*` are NULLABLE — "create then price" (plan §1 case 3):
 * `content:afterSave` may upsert a bare row (product_id only) before any
 * commercial data is ever entered. `idempotency_key` is per-row, mutable,
 * NOT unique (plan §4 — distinct from Phase 0's `reservations`, which is a
 * global UNIQUE claim table).
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
			.addColumn("sku", "text", (col) => col.unique())
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
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			.execute();
	},
};
