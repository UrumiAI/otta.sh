import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for `product_variants`: ONE COMMERCE ROW PER SELLABLE
 * UNIT. Stock and price are sku-level facts by construction, so a size that can
 * be bought on its own is a row, not a decoration on the product row.
 *
 * Portable Kysely DDL (identical for better-sqlite3 and pg; CLAUDE.md:
 * migrations are forward-only, never edit a shipped one), portable types only
 * (text/integer) exactly like `0002_product_commerce`.
 *
 * A SEPARATE TABLE, and this is the load-bearing shape decision. Widening
 * `product_commerce` into one-row-per-unit would re-key its primary key and
 * therefore rewrite `listProducts`, its keyset cursor, both fakes and every
 * caller — for a catalog in which no product declares a variant. As a separate
 * table it is INERT: with no rows, every existing statement is byte-identical,
 * and the eventual "one row per sellable unit" list is `product_commerce LEFT
 * JOIN product_variants`, which yields exactly one row per product until a
 * variant exists. That list's cursor EXTENDS the existing `(created_at,
 * product_id)` position with `variant_key` as a third component rather than
 * replacing it, which is why the intra-product order below is the key.
 *
 * PRIMARY KEY `(product_id, variant_key)` — the key is the CMS repeater row's
 * own stable identifier and it is IMMUTABLE, so it is the identity rather than a
 * column: it appears in no `SET` clause in any adapter, and no write input
 * carries a field that could change it. The PK also serves the only read shape
 * this table has (`WHERE product_id = ? ORDER BY variant_key`), so no secondary
 * index is added for it.
 *
 * NO FOREIGN KEY onto `product_commerce`. The repeater's sync POST and
 * `content:afterSave`'s are independent fire-and-forget deliveries, so a variant
 * can legitimately arrive before its product row — exactly as `activate` can.
 * The port converges that by watermark; an FK would abort it instead. This
 * mirrors `inventory_stock_movements`, which declines an FK onto `inventory.sku`
 * for the same "handled in-app, never an abort" reason.
 *
 * `sku` and `price_*` are NULLABLE — "declare then price": the CMS declares a
 * variant (key + display name, nothing commercial) and an admin prices it later,
 * so a fresh row carries neither. An absent price is ABSENT, never zero.
 *
 * `title` is the variant's display-name CACHE, single-writer, fed only by the
 * CMS sync (`adr/0016-variant-title-is-cms-owned.md`) — ADR-0013 one level down.
 * It exists so an order line can snapshot the size a buyer actually bought
 * without a cross-database read.
 *
 * `orphaned_at` is the presence tombstone: non-null once the CMS stops declaring
 * the key. Deactivation, never deletion — an orphaned variant may still hold
 * stock and still sit on live order lines. Live-sku uniqueness is therefore a
 * PARTIAL unique index over non-orphaned rows only, exactly as
 * `product_commerce_live_sku_unique` is partial over non-deleted ones: the
 * tombstone keeps the history without locking the identifier forever.
 *
 * `content_updated_at` is the ONE ordering watermark for BOTH presence
 * transitions (declare and orphan). They arrive on the SAME save event — a save
 * either re-declares a key or does not — so one watermark orders both correctly,
 * unlike the product's publish gate, whose opposing transitions arrive on
 * separate events and needed a column of their own.
 */
export const migration0023ProductVariants: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("product_variants")
			.addColumn("product_id", "text", (col) => col.notNull())
			.addColumn("variant_key", "text", (col) => col.notNull())
			.addColumn("sku", "text")
			.addColumn("price_cents", "integer", (col) => col.check(sql`price_cents >= 0`))
			.addColumn("price_currency", "text")
			.addColumn("title", "text")
			.addColumn("orphaned_at", "text")
			.addColumn("idempotency_key", "text", (col) => col.notNull())
			.addColumn("content_updated_at", "text")
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			.addPrimaryKeyConstraint("product_variants_pkey", ["product_id", "variant_key"])
			.execute();

		// Live-rows-only sku uniqueness at variant grain (see the header). Raw
		// predicate for the same reason 0002 uses one: Kysely's index builder only
		// offers indexed columns to `where`'s typed overload, and the partial-index
		// predicate is over `orphaned_at`.
		await db.schema
			.createIndex("product_variants_live_sku_unique")
			.on("product_variants")
			.column("sku")
			.unique()
			.where(sql<boolean>`orphaned_at is null`)
			.execute();
	},
};
