import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration adding the two missing order-lookup indices. Never
 * edit a shipped migration — correct forward.
 *
 * - `idx_orders_customer_id` backs `KyselyOrderStore#listForCustomer`
 *   (storefront order history), which filters `orders.customer_id =
 *   :customerId`, orders by `(created_at, id)`, then fans out `#loadById` per
 *   row — today a full scan on every lookup. It is a COMPOSITE PARTIAL index
 *   — `(customer_id, created_at, id) WHERE customer_id IS NOT NULL` — rather
 *   than a plain `(customer_id)` b-tree: `customer_id` is ~90% NULL (orders
 *   are born unlinked and only back-filled to a customer at a later login —
 *   the Phase-5 relink flow), so the partial predicate excludes the majority
 *   of rows the index would otherwise carry, and trailing `created_at, id`
 *   lets `listForCustomer`'s `ORDER BY created_at, id` come straight off the
 *   index with no separate sort step. Measured at 50k rows / 90% NULL: 304 kB
 *   vs. 464 kB for the plain form, and the plan drops a `Sort` node.
 *   `linkGuestOrders`' `WHERE customer_id IS NULL` half is unaffected — that
 *   predicate is excluded from this index by construction and is driven by
 *   `idx_orders_buyer_ref_lower` instead, with `customer_id IS NULL` applied
 *   as a heap filter. The customer-key union (`customer_id = :id OR
 *   lower(buyer_ref) = lower(:buyerRef)` in `orderFilterConditions`) still
 *   uses this index for its `customer_id = :id` half: the planner proves
 *   equality to a literal implies `IS NOT NULL` and picks the partial index.
 * - `idx_orders_buyer_ref_lower` is a FUNCTIONAL index on `lower(buyer_ref)`.
 *   Its consumers are the EQUALITY predicates on `buyer_ref`, each folded at
 *   the compare side (`lower(buyer_ref) = lower(:buyerRef)`):
 *   `KyselyOrderStore#linkGuestOrders` and the `customer` key half of
 *   `orderFilterConditions` (`customer_id = :id OR lower(buyer_ref) =
 *   lower(:buyerRef)`) in `kysely-order-store.ts`. NOT the admin list's
 *   `search`: that is an id PREFIX or an unanchored `buyer_ref` SUBSTRING
 *   (port doc), which no b-tree can serve and which deliberately scans. A
 *   plain b-tree on `buyer_ref` would never be chosen by the planner for the
 *   equality queries either, so the index expression matches `lower(buyer_ref)`
 *   exactly — Postgres resolves an unqualified vs. `orders.`-qualified column
 *   reference to the same parsed expression node, so this one expression serves
 *   both call-site spellings.
 *
 *   WHAT THE TEST ACTUALLY PINS. `order-lookup-indices.test.ts` EXPLAINs the
 *   three statements above (`listForCustomer`, `linkGuestOrders`, the customer
 *   key) and asserts each plan names the index it was built for. That catches a
 *   rewrite of THOSE predicates — a different fold, a column swap — by failing
 *   loudly rather than silently losing the index. It does NOT cover every
 *   predicate in the store, and never covered `search`; a query the test does
 *   not EXPLAIN can drop off an index with nothing turning red.
 *
 * Neither duplicates the existing `orders` indices: `idx_orders_created_state`
 * (`created_at, state`, `0008`) and `idx_orders_created_id` (the admin keyset
 * `created_at, id`, `0009`).
 *
 * No `CONCURRENTLY`: matches `0008`/`0009` precedent (plain `createIndex`,
 * cheap insurance rather than a performance target) and the migration runner
 * wraps each migration in a transaction, inside which `CREATE INDEX
 * CONCURRENTLY` cannot run on Postgres.
 *
 * SQLite equivalent: no dialect fork needed. SQLite has supported expression
 * indices and partial indices since 3.9.0/3.8.0, and `lower()` is standard
 * SQL on both dialects (the same claim `linkGuestOrders` already relies on).
 * `idx_orders_customer_id` is built with the portable Kysely column/`where`
 * builder, which is genuinely dialect-agnostic. `idx_orders_buyer_ref_lower`
 * instead uses a raw `sql` fragment (`column(sql\`lower(buyer_ref)\`)`) — the
 * builder has no typed API for an expression column, so this one is NOT a
 * portable-builder construct. It still emits byte-identical DDL on
 * better-sqlite3 and pg, but only because `lower(x)` happens to be spelled
 * the same on both dialects; a less portable expression here would need an
 * explicit per-dialect branch. Confirmed identical by running this migration
 * against both dialects (`migration-gap.test.ts` for sqlite,
 * `order-lookup-indices.test.ts` for pg).
 */
export const migration0022OrderLookupIndices: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createIndex("idx_orders_customer_id")
			.ifNotExists()
			.on("orders")
			.columns(["customer_id", "created_at", "id"])
			.where("customer_id", "is not", null)
			.execute();

		await db.schema
			.createIndex("idx_orders_buyer_ref_lower")
			.ifNotExists()
			.on("orders")
			.column(sql`lower(buyer_ref)`)
			.execute();
	},
};
