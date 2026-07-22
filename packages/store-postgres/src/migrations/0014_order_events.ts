import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the order timeline / audit slice (admin-UX
 * Increment 1, timeline slice). Adds the append-only `order_events` table — one
 * row per durable state change, INSERTed inside the SAME guarded-flip
 * transaction that moves the order (the `#flipAndEnqueue` choke point in
 * `KyselyOrderStore`), so an event exists iff the flip won (a replay / lost race
 * writes none). Columns:
 *   - `id`         — event id (store idGen)
 *   - `order_id`   — the order the event belongs to
 *   - `at`         — ISO-8601 UTC record timestamp (store clock at the flip)
 *   - `kind`       — currently always `'state_change'` (text ⇒ new kinds need no DDL)
 *   - `from_state` — the state left (nullable)
 *   - `to_state`   — the state entered (nullable)
 *   - `actor`      — who triggered it when known (recorder/canceller); nullable
 *
 * Written with the Kysely schema builder so identical portable DDL emits for
 * better-sqlite3 and pg (CLAUDE.md: migrations are forward-only; never edit a
 * shipped one). No hard FK to `orders` — same rationale as `order_notes` (0010):
 * every read is scoped by `order_id`, so the scoping (not a referential
 * constraint) is the integrity guarantee. The composite index on `(order_id, at,
 * id)` is exactly the `listEventsForOrder` order (`WHERE order_id = ? ORDER BY at
 * ASC, id ASC`). Orders that transitioned BEFORE this migration have no events —
 * the timeline read-model degrades gracefully (it merges the order's derived
 * artifacts for those).
 */
export const migration0014OrderEvents: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("order_events")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("order_id", "text", (col) => col.notNull())
			.addColumn("at", "text", (col) => col.notNull())
			.addColumn("kind", "text", (col) => col.notNull())
			.addColumn("from_state", "text")
			.addColumn("to_state", "text")
			.addColumn("actor", "text")
			.execute();

		await sql`CREATE INDEX order_events_list_idx ON order_events (order_id, at, id)`.execute(db);
	},
};
