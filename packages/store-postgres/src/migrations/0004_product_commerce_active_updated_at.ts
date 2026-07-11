import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only correction (§ forward-only migrations): add the publish-gate
 * ordering watermark `active_updated_at` to `product_commerce`. Written with the
 * Kysely schema builder so identical, portable DDL emits for better-sqlite3 and
 * pg. Never edit a shipped migration — correct forward.
 *
 * This column is NOT part of `0002_product_commerce`, which shipped in an earlier
 * release without it. Kysely's `Migrator` tracks applied migrations BY NAME and
 * skips ones already run regardless of body changes, so amending 0002 in place
 * would never reach a database that already ran the original 0002 — the column
 * would silently never be added there. This migration adds it forward instead.
 *
 * `active_updated_at` is the PUBLISH-GATE ordering watermark: the CMS content's
 * own `updatedAt` last applied by a winning `activate`/`deactivate`. It is
 * DELIBERATELY separate from `content_updated_at` — `activate`/`deactivate` are
 * opposing transitions on the same `active` flag delivered by independent
 * fire-and-forget hook POSTs, so a stale out-of-order publish/unpublish must be
 * gated by a watermark; but a plain `content:afterSave` advances
 * `content_updated_at` WITHOUT being a lifecycle event, so reusing that column
 * would let a save poison the gate. Nullable, no backfill — NULL is treated as
 * `-infinity` by the store guard, so the first lifecycle transition always wins.
 * ISO-8601 text (lexicographic = chronological).
 */
export const migration0004ProductCommerceActiveUpdatedAt: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema.alterTable("product_commerce").addColumn("active_updated_at", "text").execute();
	},
	async down(db: Kysely<unknown>): Promise<void> {
		await db.schema.alterTable("product_commerce").dropColumn("active_updated_at").execute();
	},
};
