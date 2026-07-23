import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the admin Coupons console list (view-only,
 * admin-UX Increment 3, "coupon enumerate + coupon list"). `coupons` shipped in
 * `0007_shipping_tax_coupons.ts` with NO `created_at` column — this migration
 * adds it forward (mirrors `0004_product_commerce_active_updated_at.ts`'s
 * additive-column precedent) and indexes it for the keyset list (mirrors
 * `0015_product_commerce_admin_list_indices.ts`'s `(created_at, id)` index).
 * Written with the Kysely schema builder so identical, portable DDL emits for
 * better-sqlite3 and pg. Never edit a shipped migration — correct forward.
 *
 * `NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`, not nullable: `created_at` is
 * the keyset SORT KEY (`ORDER BY created_at DESC, id DESC`), and pg (NULLS
 * FIRST in DESC by default) and better-sqlite3 (NULLS treated as the smallest
 * value, so NULLS LAST in DESC) order NULLs OPPOSITELY — a nullable column here
 * would make `listCoupons` disagree across dialects for any pre-migration row.
 * The sentinel epoch default sorts any such row to the very end, deterministic
 * on both dialects, with no NULLS-LAST clause needed. `KyselyCouponStore.create`
 * stamps a REAL value (the injected `Clock`) for every coupon minted from here
 * on, so the sentinel is only ever hit by a row this migration finds already
 * in place.
 */
export const migration0018CouponsAdminList: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.alterTable("coupons")
			.addColumn("created_at", "text", (col) => col.notNull().defaultTo("1970-01-01T00:00:00.000Z"))
			.execute();
		await db.schema
			.createIndex("idx_coupons_created_id")
			.ifNotExists()
			.on("coupons")
			.columns(["created_at", "id"])
			.execute();
	},
};
