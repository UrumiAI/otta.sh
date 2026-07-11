import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-7 forward-only migration (§7 Step 3). Adds the service-DB `settings`
 * tier (single typed row + an idempotency ledger) and the reporting indices from
 * §4.2. Written with the Kysely schema builder so identical portable DDL emits
 * for better-sqlite3 and pg. Never edit a shipped migration — correct forward.
 *
 * Reporting itself is pure read-side over existing tables (orders / order_totals
 * / order_items / inventory) and needs no schema — only the indices below, cheap
 * insurance against full scans as volume grows (not a performance target).
 * `order_totals` needs no extra index: its PK (`order_id`) is already the join key.
 */
export const migration0008SettingsAndReportingIndices: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// -- settings (single row) --------------------------------------------------
		await db.schema
			.createTable("settings")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("hold_ttl_minutes", "integer", (col) => col.notNull())
			.addColumn("low_stock_threshold", "integer", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			.execute();

		// -- settings idempotency ledger --------------------------------------------
		await db.schema
			.createTable("settings_mutations")
			.addColumn("idempotency_key", "text", (col) => col.primaryKey())
			.addColumn("hold_ttl_minutes", "integer", (col) => col.notNull())
			.addColumn("low_stock_threshold", "integer", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		// -- reporting indices (§4.2) ------------------------------------------------
		await db.schema
			.createIndex("idx_orders_created_state")
			.ifNotExists()
			.on("orders")
			.columns(["created_at", "state"])
			.execute();

		await db.schema
			.createIndex("idx_order_items_order_product")
			.ifNotExists()
			.on("order_items")
			.columns(["order_id", "product_id"])
			.execute();

		await db.schema
			.createIndex("idx_inventory_on_hand")
			.ifNotExists()
			.on("inventory")
			.columns(["on_hand"])
			.execute();
	},
};
