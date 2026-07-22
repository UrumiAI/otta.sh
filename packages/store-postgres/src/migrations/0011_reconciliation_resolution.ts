import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the reconciliation-resolution slice (admin-UX
 * Increment 1). The `orders.reconciliation_flag` column already marks an order
 * that settle could not auto-settle (a lost hold / a paid-flip loss); it was
 * WRITE-ONLY until now. This adds the four nullable columns that record an admin's
 * disposition when they RESOLVE that flag — cleared atomically with the flag in a
 * single guarded UPDATE (`resolveReconciliation`):
 *   - `reconciliation_outcome`      — 'refunded' | 'fulfilled' | 'written_off'
 *   - `reconciliation_reason`       — free-text justification
 *   - `reconciliation_resolved_by`  — who resolved it (free text, like a note author)
 *   - `reconciliation_resolved_at`  — ISO-8601 UTC timestamp (text, like the other
 *                                     order timestamps — lexical order == chronological)
 *
 * All nullable + additive: existing rows read as `null` (never flagged / not yet
 * resolved), and no shipped migration is edited (CLAUDE.md: forward-only). The
 * Kysely schema builder emits identical portable DDL for better-sqlite3 and pg.
 * No CHECK constraint on the outcome value — the enum is enforced in the domain
 * use-case + the service's zod schema (the domain, not the DB, owns legality).
 */
export const migration0011ReconciliationResolution: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// One ADD COLUMN per ALTER TABLE — SQLite rejects multiple column additions
		// in a single statement (pg accepts it, but keeping them separate stays
		// dialect-identical, CLAUDE.md portable-DDL discipline).
		for (const column of [
			"reconciliation_outcome",
			"reconciliation_reason",
			"reconciliation_resolved_by",
			"reconciliation_resolved_at",
		] as const) {
			await db.schema.alterTable("orders").addColumn(column, "text").execute();
		}
	},
};
