import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Phase-5 forward-only migration (§4/§5/§10): storefront customer identity
 * (customers, addresses, customer_sessions, login_challenges) and the
 * order-status email outbox. Written with the Kysely schema builder so identical
 * portable DDL emits for better-sqlite3 and pg. Never edit a shipped migration —
 * correct forward.
 *
 * `orders.customer_id` is **not** migrated here — Phase 4 (0005) already added it
 * forward-only; Phase 5 only populates it (on login/claim). No `orders`/
 * `order_items`/`order_totals` column is added or renamed.
 */
export const migration0006CustomersSessionsOutbox: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		// customers — storefront identity, separate from EmDash ctx.users (§4).
		// email is UNIQUE + lower-normalized (the domain Email brand normalizes).
		await db.schema
			.createTable("customers")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("email", "text", (col) => col.notNull().unique())
			.addColumn("display_name", "text")
			.addColumn("email_verified_at", "text")
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		// customer_sessions — opaque DB-backed tokens; token_hash only (§4). No hard
		// FK to customers (mirrors order_items/entitlements, plan §4): ownership is a
		// scoped lookup, not a join, so a hard FK adds no invariant here.
		await db.schema
			.createTable("customer_sessions")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("customer_id", "text", (col) => col.notNull())
			.addColumn("token_hash", "text", (col) => col.notNull().unique())
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("expires_at", "text", (col) => col.notNull())
			.addColumn("revoked_at", "text")
			.execute();

		// login_challenges — one-time magic-link tokens; token_hash only, single-use
		// via consumed_at (§4). No customer FK: a challenge can precede the account
		// (first login creates it on verify).
		await db.schema
			.createTable("login_challenges")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("email", "text", (col) => col.notNull())
			.addColumn("token_hash", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			.addColumn("expires_at", "text", (col) => col.notNull())
			.addColumn("consumed_at", "text")
			.execute();

		// addresses — customer-scoped address book (§4). No hard FK (same rationale
		// as customer_sessions): every port method filters by customer_id, so the
		// scoping — not a referential constraint — is the isolation guarantee.
		// is_default is portable 0/1.
		await db.schema
			.createTable("addresses")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("customer_id", "text", (col) => col.notNull())
			.addColumn("kind", "text", (col) => col.notNull())
			.addColumn("name", "text", (col) => col.notNull())
			.addColumn("line1", "text", (col) => col.notNull())
			.addColumn("line2", "text")
			.addColumn("city", "text", (col) => col.notNull())
			.addColumn("region", "text")
			.addColumn("postal_code", "text", (col) => col.notNull())
			.addColumn("country", "text", (col) => col.notNull())
			.addColumn("is_default", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		// order_emails_outbox — exactly-once email enqueue + claim (§5). The guarded
		// state UPDATE and this INSERT commit in one transaction; UNIQUE(order_id,
		// to_state) makes the enqueue idempotent under retry/redelivery.
		await db.schema
			.createTable("order_emails_outbox")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("order_id", "text", (col) => col.notNull().references("orders.id"))
			.addColumn("to_state", "text", (col) => col.notNull())
			.addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
			.addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("lease_until", "text")
			.addColumn("sent_at", "text")
			.addColumn("created_at", "text", (col) => col.notNull())
			.addUniqueConstraint("order_emails_outbox_order_state_uk", ["order_id", "to_state"])
			.execute();

		// Index the claim predicate's hot path (pending rows in creation order).
		await sql`CREATE INDEX order_emails_outbox_dispatch_idx ON order_emails_outbox (status, created_at)`.execute(
			db,
		);
	},
};
