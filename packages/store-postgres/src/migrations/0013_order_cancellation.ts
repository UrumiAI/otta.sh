import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the order-cancellation slice (admin-UX Increment
 * 1, "cancel with reason"). Adds the four nullable columns that record an
 * order's structured cancellation — written atomically with the
 * `{pending,paid,processing} → cancelled` transition by `cancelOrder` (which
 * makes the cancelled-notification email carry WHY instead of a reason-free
 * notice):
 *   - `cancellation_reason`        — the structured reason enum (free text)
 *   - `cancellation_detail`        — optional free-text elaboration
 *   - `cancellation_cancelled_by`  — who cancelled it (free text, like a note author)
 *   - `cancellation_cancelled_at`  — ISO-8601 UTC record timestamp (presence witness)
 *
 * All nullable + additive: existing rows read as `null` (no reason recorded —
 * including every order already cancelled via the bare `transition` before this
 * slice, an honest back-compat state), and no shipped migration is edited
 * (CLAUDE.md: forward-only). The Kysely schema builder emits identical portable
 * DDL for better-sqlite3 and pg. Single-slot: this domain cancels an order once
 * (terminal state), so one set of columns, not a child table.
 */
export const migration0013OrderCancellation: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// One ADD COLUMN per ALTER TABLE — SQLite rejects multiple column additions
		// in a single statement (pg accepts it, but keeping them separate stays
		// dialect-identical, CLAUDE.md portable-DDL discipline).
		for (const column of [
			"cancellation_reason",
			"cancellation_detail",
			"cancellation_cancelled_by",
			"cancellation_cancelled_at",
		] as const) {
			await db.schema.alterTable("orders").addColumn(column, "text").execute();
		}
	},
};
