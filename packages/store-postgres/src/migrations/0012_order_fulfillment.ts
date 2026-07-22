import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the order-fulfillment slice (admin-UX Increment 1).
 * Adds the six nullable columns that record an order's shipping fulfillment —
 * written atomically with the `processing → shipped` transition by
 * `recordFulfillment` (which makes the shipped-notification email carry tracking
 * instead of being empty):
 *   - `fulfillment_carrier`          — shipping carrier (free text)
 *   - `fulfillment_tracking_number`  — carrier tracking number (free text)
 *   - `fulfillment_tracking_url`     — optional carrier tracking URL
 *   - `fulfillment_shipped_at`       — ISO-8601 UTC ship time (admin or store clock)
 *   - `fulfillment_recorded_by`      — who recorded it (free text, like a note author)
 *   - `fulfillment_recorded_at`      — ISO-8601 UTC record timestamp (presence witness)
 *
 * All nullable + additive: existing rows read as `null` (never fulfilled), and no
 * shipped migration is edited (CLAUDE.md: forward-only). The Kysely schema builder
 * emits identical portable DDL for better-sqlite3 and pg. Timestamps are text
 * (like the other order timestamps — lexical order == chronological). Single-slot:
 * this domain ships an order once, so one set of columns, not a child table.
 */
export const migration0012OrderFulfillment: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// One ADD COLUMN per ALTER TABLE — SQLite rejects multiple column additions
		// in a single statement (pg accepts it, but keeping them separate stays
		// dialect-identical, CLAUDE.md portable-DDL discipline).
		for (const column of [
			"fulfillment_carrier",
			"fulfillment_tracking_number",
			"fulfillment_tracking_url",
			"fulfillment_shipped_at",
			"fulfillment_recorded_by",
			"fulfillment_recorded_at",
		] as const) {
			await db.schema.alterTable("orders").addColumn(column, "text").execute();
		}
	},
};
