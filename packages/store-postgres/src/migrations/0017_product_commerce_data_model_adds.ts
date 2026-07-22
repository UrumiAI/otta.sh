import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration (product data-model adds, admin-UX Increment 2 slice
 * 5): four merchant-standard commercial fields on `product_commerce`, added
 * additively — every column is nullable or DEFAULTed so existing rows migrate
 * with no backfill and the CMS-sync upsert (which never writes these) keeps
 * working unchanged.
 *
 *  - `compare_at_cents` / `compare_at_currency` — the optional struck-through
 *    "was" price. Nullable; `compare_at_cents >= 0` (a CHECK, mirroring
 *    `price_cents`). Shares the row's price currency (enforced in the store's
 *    edit guard, not by DDL — a cross-column currency rule is application-level).
 *  - `unit_cost_cents` / `unit_cost_currency` — the optional ADMIN-ONLY unit
 *    cost. Same nullable + non-negative CHECK shape. Never serialized on a
 *    storefront-facing read path (enforced in the service, pinned by a test).
 *  - `inventory_policy` — the out-of-stock policy. `text NOT NULL DEFAULT
 *    'deny'` — `'deny'` is the ONLY value this slice ships (no-oversell is
 *    non-negotiable; backorders are a future slice). Stored as text (not an
 *    enum) for the same portable-types-only discipline the rest of this table
 *    follows (better-sqlite3 has no native enum); the value set is bounded by
 *    the domain `InventoryPolicy` union + the service zod enum, not the DB.
 *
 * Portable types only (text/integer) so identical DDL emits for better-sqlite3
 * and pg. Never edit a shipped migration — this is a new one.
 */
export const migration0017ProductCommerceDataModelAdds: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.alterTable("product_commerce")
			.addColumn("compare_at_cents", "integer", (col) => col.check(sql`compare_at_cents >= 0`))
			.execute();
		await db.schema
			.alterTable("product_commerce")
			.addColumn("compare_at_currency", "text")
			.execute();
		await db.schema
			.alterTable("product_commerce")
			.addColumn("unit_cost_cents", "integer", (col) => col.check(sql`unit_cost_cents >= 0`))
			.execute();
		await db.schema
			.alterTable("product_commerce")
			.addColumn("unit_cost_currency", "text")
			.execute();
		await db.schema
			.alterTable("product_commerce")
			.addColumn("inventory_policy", "text", (col) => col.notNull().defaultTo("deny"))
			.execute();
	},
};
