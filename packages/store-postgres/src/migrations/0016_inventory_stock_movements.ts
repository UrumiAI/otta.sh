import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the merchant stock-movement ledger (admin-UX
 * Increment 2 — the restock slice). Per-mutation claim ledger for
 * `InventoryStore.restock`/`removeStock`, the admin analogue of
 * `inventory_adjustments` (which is reservation-scoped): this one is
 * bare-sku-scoped. The claim INSERT and the guarded inventory movement commit in
 * ONE short transaction, so exactly one caller per key moves stock and a replay
 * returns the recorded outcome instead of re-applying a delta.
 *
 * Portable Kysely DDL (identical for better-sqlite3 and pg; CLAUDE.md: migrations
 * are forward-only, never edit a shipped one). No hard FK to `inventory.sku` —
 * an UNKNOWN_SKU movement is handled in-app (the guarded UPDATE matches 0 rows
 * and the claim rolls back, mirroring `reserve`'s unknown-sku parity), so an FK
 * abort is neither needed nor wanted. `qty > 0` is checked at the column.
 */
export const migration0016InventoryStockMovements: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("inventory_stock_movements")
			.addColumn("idempotency_key", "text", (col) => col.primaryKey())
			.addColumn("sku", "text", (col) => col.notNull())
			.addColumn("direction", "text", (col) => col.notNull())
			.addColumn("qty", "integer", (col) => col.notNull().check(sql`qty > 0`))
			.addColumn("outcome", "text", (col) => col.notNull())
			.addColumn("result_on_hand", "integer", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();
	},
};
