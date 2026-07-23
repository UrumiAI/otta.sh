import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for checkout address capture (ADR-0009). Creates the 1:1
 * `order_shipping_address` table — the immutable shipping-address snapshot frozen
 * onto an order at creation, mirroring `order_totals`:
 *   - `order_id`    — PK + FK to `orders.id` (1:1; a row exists iff a ship-to was captured)
 *   - `name`        — recipient name (required)
 *   - `line1`       — street line 1 (required)
 *   - `line2`       — street line 2 (optional)
 *   - `city`        — city (required)
 *   - `region`      — state/province (optional)
 *   - `postal_code` — postal/ZIP code (required)
 *   - `country`     — country (required; free string, no zone matching — ADR-0009 §5)
 *   - `email`       — optional contact channel
 *   - `phone`       — optional contact channel
 *
 * Additive + non-breaking: no existing order gets a row (historical orders keep an
 * honest "no ship-to on file" state via the left join reading `null`), and no
 * shipped migration is edited (CLAUDE.md: forward-only). The Kysely schema builder
 * emits identical portable DDL for better-sqlite3 and pg. The snapshot is
 * insert-once — no code path ever UPDATEs this table (immutability is structural,
 * the `order_items`/`order_totals` precedent).
 */
export const migration0019OrderShippingAddress: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("order_shipping_address")
			.addColumn("order_id", "text", (col) => col.primaryKey().references("orders.id"))
			.addColumn("name", "text", (col) => col.notNull())
			.addColumn("line1", "text", (col) => col.notNull())
			.addColumn("line2", "text")
			.addColumn("city", "text", (col) => col.notNull())
			.addColumn("region", "text")
			.addColumn("postal_code", "text", (col) => col.notNull())
			.addColumn("country", "text", (col) => col.notNull())
			.addColumn("email", "text")
			.addColumn("phone", "text")
			.execute();
	},
};
