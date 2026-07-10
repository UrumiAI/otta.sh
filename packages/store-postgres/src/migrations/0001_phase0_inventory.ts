import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-0 forward-only migration (§6): `inventory` + `reservations`.
 * Written with the Kysely schema builder so identical, portable DDL emits for
 * both dialects. Never edit a shipped migration — correct forward with 0002_….
 */
export const migration0001PhaseInventory: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("inventory")
			.addColumn("sku", "text", (col) => col.primaryKey())
			.addColumn("on_hand", "integer", (col) => col.notNull().check(sql`on_hand >= 0`))
			.execute();

		await db.schema
			.createTable("reservations")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("sku", "text", (col) => col.notNull().references("inventory.sku"))
			.addColumn("qty", "integer", (col) => col.notNull().check(sql`qty > 0`))
			.addColumn("state", "text", (col) => col.notNull())
			.addColumn("idempotency_key", "text", (col) => col.notNull().unique())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();
	},
};
