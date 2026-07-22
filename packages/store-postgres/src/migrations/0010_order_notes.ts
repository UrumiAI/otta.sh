import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for order notes (admin-UX Increment 0 — the walking
 * skeleton's smallest full slice). Append-only merchant annotations on an order's
 * mutable envelope: `{author, body, created_at}`, guarded by `idempotency_key`
 * UNIQUE so a replayed append inserts exactly once.
 *
 * Written with the Kysely schema builder so identical portable DDL emits for
 * better-sqlite3 and pg (CLAUDE.md: migrations are forward-only; never edit a
 * shipped one). No hard FK to `orders` — same rationale as `customer_sessions`/
 * `addresses` (0006): every read is scoped by `order_id`, and the
 * `appendOrderNote` use-case enforces order existence, so the scoping (not a
 * referential constraint) is the integrity guarantee. The composite index on
 * `(order_id, created_at, id)` is exactly the `listForOrder` order
 * (`WHERE order_id = ? ORDER BY created_at ASC, id ASC`).
 */
export const migration0010OrderNotes: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("order_notes")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("order_id", "text", (col) => col.notNull())
			.addColumn("author", "text", (col) => col.notNull())
			.addColumn("body", "text", (col) => col.notNull())
			.addColumn("idempotency_key", "text", (col) => col.notNull().unique())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		await sql`CREATE INDEX order_notes_list_idx ON order_notes (order_id, created_at, id)`.execute(
			db,
		);
	},
};
