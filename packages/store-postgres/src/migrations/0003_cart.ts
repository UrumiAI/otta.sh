import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-3 forward-only migration (§4): the cart schema, plus the hold deadline
 * on the existing `reservations` table. Written with the Kysely schema builder
 * so identical, portable DDL emits for better-sqlite3 and pg. Never edit a
 * shipped migration — correct forward.
 *
 * Numbered `0003`: `0002` is reserved for Phase 1's `product_commerce`, and this
 * migration must not depend on it (its `cart_lines.product_id` is a plain,
 * nullable forward hook with no FK to a product table).
 */
export const migration0003Cart: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// Add the hold deadline to Phase-0's `reservations` (state already exists —
		// not redeclared here). Nullable: a raw `reserve` sets none; the cart stamps
		// it, and a crashed hold with none is reaped via `created_at` + TTL.
		await db.schema.alterTable("reservations").addColumn("expires_at", "text").execute();

		await db.schema
			.createTable("carts")
			.addColumn("id", "text", (col) => col.primaryKey())
			// Forward hook for Phase 5 (anonymous → customer); merge logic is Phase 5.
			.addColumn("customer_id", "text")
			.addColumn("state", "text", (col) => col.notNull().defaultTo("active"))
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			.execute();

		await db.schema
			.createTable("cart_lines")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("cart_id", "text", (col) => col.notNull().references("carts.id"))
			.addColumn("product_id", "text")
			.addColumn("sku", "text", (col) => col.notNull())
			.addColumn("qty", "integer", (col) => col.notNull().check(sql`qty > 0`))
			// Explicitly nullable: a digital line (Phase 4) carries no reservation, so
			// Phase 4's design needs no forward-only ALTER.
			.addColumn("reservation_id", "text", (col) => col.references("reservations.id"))
			.addColumn("expires_at", "text")
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			// One line per sku — the uniqueness that dedupes an add-to-cart.
			.addUniqueConstraint("cart_lines_cart_id_sku_unique", ["cart_id", "sku"])
			.execute();

		// Dedicated cart-mutation idempotency ledger (§4): one row per accepted
		// add/adjust/remove, keyed uniquely on the client's idempotency key. Required
		// (not a reuse of `reservations.idempotency_key`, which is already consumed by
		// the original reserve and cannot guard the many adjusts over a line's life).
		await db.schema
			.createTable("cart_mutations")
			.addColumn("idempotency_key", "text", (col) => col.primaryKey())
			.addColumn("cart_id", "text", (col) => col.notNull())
			.addColumn("line_id", "text")
			.addColumn("kind", "text", (col) => col.notNull())
			.addColumn("resulting_qty", "integer")
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();
	},
};
