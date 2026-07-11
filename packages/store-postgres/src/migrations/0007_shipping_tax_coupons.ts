import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-6 forward-only migration (§5): shipping zones/methods/rates, tax
 * classes/rates, and coupons + coupon_redemptions. Written with the Kysely schema
 * builder so identical portable DDL emits for better-sqlite3 and pg. Never edit a
 * shipped migration — correct forward.
 *
 * Money convention (§4): every amount is `*_cents` (integer minor units); every
 * rate is `*_bps` (integer basis points). `order_totals` is NOT touched here —
 * per the Phase-4 canonical schema it already exists; Phase 6 only writes richer
 * values into its existing columns.
 */
export const migration0007ShippingTaxCoupons: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// -- Shipping --------------------------------------------------------------
		await db.schema
			.createTable("shipping_zones")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("name", "text", (col) => col.notNull())
			.addColumn("regions", "text") // opaque JSON-as-text match list
			.execute();

		await db.schema
			.createTable("shipping_methods")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("zone_id", "text", (col) => col.notNull().references("shipping_zones.id"))
			.addColumn("name", "text", (col) => col.notNull())
			.addColumn("type", "text", (col) => col.notNull())
			.execute();

		await db.schema
			.createTable("shipping_rates")
			.addColumn("method_id", "text", (col) => col.notNull().references("shipping_methods.id"))
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("amount_cents", "integer", (col) => col.notNull().check(sql`amount_cents >= 0`))
			.addColumn("min_subtotal_cents", "integer", (col) => col.check(sql`min_subtotal_cents >= 0`))
			// One rate per (method, currency).
			.addPrimaryKeyConstraint("shipping_rates_pk", ["method_id", "currency"])
			.execute();

		// -- Tax -------------------------------------------------------------------
		await db.schema
			.createTable("tax_classes")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("name", "text", (col) => col.notNull())
			.execute();

		await db.schema
			.createTable("tax_rates")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("tax_class_id", "text", (col) => col.notNull())
			.addColumn("zone_id", "text", (col) => col.notNull())
			.addColumn("rate_bps", "integer", (col) => col.notNull().check(sql`rate_bps >= 0`))
			// Portable 0/1 — better-sqlite3 cannot bind a JS boolean.
			.addColumn("applies_to_shipping", "integer", (col) => col.notNull().defaultTo(0))
			.execute();

		// -- Coupons ---------------------------------------------------------------
		await db.schema
			.createTable("coupons")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("code", "text", (col) => col.notNull().unique())
			.addColumn("type", "text", (col) => col.notNull())
			.addColumn("amount_cents", "integer", (col) => col.check(sql`amount_cents >= 0`))
			.addColumn("rate_bps", "integer", (col) => col.check(sql`rate_bps >= 0`))
			.addColumn("cap_cents", "integer", (col) => col.check(sql`cap_cents >= 0`))
			.addColumn("currency", "text")
			.addColumn("min_subtotal_cents", "integer", (col) => col.check(sql`min_subtotal_cents >= 0`))
			.addColumn("starts_at", "text")
			.addColumn("expires_at", "text")
			.addColumn("max_uses", "integer", (col) => col.check(sql`max_uses >= 0`))
			.addColumn("max_uses_per_customer", "integer", (col) =>
				col.check(sql`max_uses_per_customer >= 0`),
			)
			// The atomic redemption guard reads/writes this; CHECK keeps it non-negative.
			.addColumn("uses_count", "integer", (col) =>
				col
					.notNull()
					.defaultTo(0)
					.check(sql`uses_count >= 0`),
			)
			.execute();

		await db.schema
			.createTable("coupon_redemptions")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("coupon_id", "text", (col) => col.notNull().references("coupons.id"))
			.addColumn("order_id", "text", (col) => col.notNull())
			.addColumn("customer_id", "text")
			.addColumn("idempotency_key", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			// Replay of the same checkout is a no-op re-read (mirrors reservations).
			.addUniqueConstraint("coupon_redemptions_coupon_key", ["coupon_id", "idempotency_key"])
			.execute();
	},
};
