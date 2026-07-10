import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-4 forward-only migration (§4/§10): the order / payment / entitlement
 * schema, plus the additive `reservations.order_id` + `adopted` state and the
 * additive `product_commerce.title` (the order-line snapshot source). Written
 * with the Kysely schema builder so identical portable DDL emits for
 * better-sqlite3 and pg. Never edit a shipped migration — correct forward.
 *
 * Money convention (§4): every amount is `*_cents` (integer minor units) + an
 * explicit `currency`. **`orders` carries no money column** — totals live only in
 * `order_totals`.
 */
export const migration0005Orders: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// Additive: the owning order on a reservation (nullable). `adopted` is a new
		// reservation-state VALUE — the state column is plain text (no enum type to
		// alter), so no DDL is needed for the value itself; it is invisible to the
		// Phase-3 `held`-scoped sweep by construction.
		await db.schema.alterTable("reservations").addColumn("order_id", "text").execute();

		// Additive: the product title the order line snapshots (Phase 4 §4).
		await db.schema.alterTable("product_commerce").addColumn("title", "text").execute();

		// orders — NO money column; keys / state / TTL / identity only (§4).
		await db.schema
			.createTable("orders")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("cart_id", "text")
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("state", "text", (col) => col.notNull().defaultTo("pending"))
			// Order-creation dedupe (§4): a replay returns the existing order.
			.addColumn("idempotency_key", "text", (col) => col.notNull().unique())
			.addColumn("hold_expires_at", "text", (col) => col.notNull())
			.addColumn("payment_method", "text")
			.addColumn("buyer_ref", "text", (col) => col.notNull())
			// Phase-5 hook; nullable, populated by Phase 5 (lands exactly once, §4).
			.addColumn("customer_id", "text")
			.addColumn("reconciliation_flag", "text")
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("updated_at", "text", (col) => col.notNull())
			.execute();

		// order_items — insert-once; price/title/currency are snapshots (§4).
		await db.schema
			.createTable("order_items")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("order_id", "text", (col) => col.notNull().references("orders.id"))
			.addColumn("product_id", "text", (col) => col.notNull())
			.addColumn("sku", "text", (col) => col.notNull())
			.addColumn("title", "text", (col) => col.notNull())
			.addColumn("unit_price_cents", "integer", (col) =>
				col.notNull().check(sql`unit_price_cents >= 0`),
			)
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("quantity", "integer", (col) => col.notNull().check(sql`quantity > 0`))
			.addColumn("fulfillment_kind", "text", (col) => col.notNull())
			// Physical only; NULL for digital (digital never reserves, §6). A plain
			// nullable link — NOT an FK: the reservation lifecycle is owned by the
			// inventory authority, and settle resolves it via the inventory port
			// (commit/release), never a join, so a hard FK adds no invariant here and
			// only complicates order retention.
			.addColumn("reservation_id", "text")
			.execute();

		// order_totals — 1:1 with orders; the authoritative totals home (§4).
		await db.schema
			.createTable("order_totals")
			.addColumn("order_id", "text", (col) => col.primaryKey().references("orders.id"))
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("subtotal_cents", "integer", (col) => col.notNull())
			.addColumn("discount_cents", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("shipping_cents", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("tax_cents", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("total_cents", "integer", (col) => col.notNull())
			.addColumn("applied_coupon_code", "text")
			.addColumn("shipping_method_snapshot", "text")
			.addColumn("tax_breakdown", "text")
			.execute();

		// payments — one recorded per settled order (§4). UNIQUE provider_ref makes
		// the record idempotent (INSERT … ON CONFLICT DO NOTHING).
		await db.schema
			.createTable("payments")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("order_id", "text", (col) => col.notNull().references("orders.id"))
			.addColumn("gateway", "text", (col) => col.notNull())
			.addColumn("provider_ref", "text", (col) => col.notNull().unique())
			.addColumn("amount_cents", "integer", (col) => col.notNull())
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("status", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		// payment_events — dedupe (UNIQUE dedupe_key; NULL for anomaly rows) + the
		// anomaly log (§5). A nullable UNIQUE column allows many anomaly rows (all
		// NULL dedupe_key) while making a real dedupe_key collide → redelivery no-op.
		await db.schema
			.createTable("payment_events")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("dedupe_key", "text", (col) => col.unique())
			.addColumn("order_id", "text", (col) => col.notNull())
			.addColumn("gateway", "text", (col) => col.notNull())
			.addColumn("kind", "text")
			.addColumn("detail", "text")
			.addColumn("received_at", "text", (col) => col.notNull())
			.execute();

		// entitlements — digital delivery authorization (§6). UNIQUE
		// grant_idempotency_key makes the grant idempotent under webhook/proof replay.
		await db.schema
			.createTable("entitlements")
			.addColumn("id", "text", (col) => col.primaryKey())
			// order_id + buyer_ref are the claim keys (§6/§7), not a hard FK.
			.addColumn("order_id", "text", (col) => col.notNull())
			.addColumn("product_id", "text")
			.addColumn("sku", "text", (col) => col.notNull())
			.addColumn("buyer_ref", "text", (col) => col.notNull())
			.addColumn("state", "text", (col) => col.notNull().defaultTo("active"))
			.addColumn("source", "text", (col) => col.notNull())
			.addColumn("granted_at", "text", (col) => col.notNull())
			.addColumn("grant_idempotency_key", "text", (col) => col.notNull().unique())
			.execute();
	},
};
