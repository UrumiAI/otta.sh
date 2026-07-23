import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for the order-refunds slice (ADR-0008). Adds the
 * append-only `refunds` ledger — the source of "how much came back" for an order,
 * keyed to the order but NEVER touching the frozen snapshot
 * (`order_items`/`order_totals`). Each row:
 *   - `id`              — refund id (store idGen)
 *   - `order_id`        — the order refunded
 *   - `amount_cents`    — the refund amount (integer minor units)
 *   - `currency`        — ISO-4217, the order's currency
 *   - `kind`            — 'gateway' (money moved via the provider) | 'manual'
 *                         (an out-of-band return the admin recorded — x402's path)
 *   - `gateway`         — 'stripe' | 'x402'
 *   - `refund_ref`      — provider refund id (gateway) or null (manual)
 *   - `reason`          — optional free-text reason (nullable)
 *   - `refunded_by`     — who issued/recorded it
 *   - `idempotency_key` — UNIQUE: the ledger dedupe AND (gateway) Stripe's native key
 *   - `created_at`      — ISO-8601 UTC (store clock)
 *
 * The ceiling `Σ refunds ≤ min(Σ captured payments, order_totals.total)` is
 * enforced in the domain/adapter guarded write (`recordRefund` locks the order
 * row, re-reads the sums, then inserts + optionally flips `→ refunded`), NOT by a
 * DB CHECK — the ceiling depends on live payment sums a column constraint cannot
 * see. `UNIQUE(idempotency_key)` is the structural once-only backstop. No hard FK
 * to `orders` — same rationale as `order_notes`/`order_events`: every read is
 * scoped by `order_id`. The composite index on `(order_id, created_at, id)` is
 * exactly the `listRefunds` order. Portable DDL via the Kysely schema builder so
 * better-sqlite3 and pg emit identically (CLAUDE.md: forward-only).
 */
export const migration0020Refunds: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createTable("refunds")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("order_id", "text", (col) => col.notNull())
			.addColumn("amount_cents", "integer", (col) => col.notNull())
			.addColumn("currency", "text", (col) => col.notNull())
			.addColumn("kind", "text", (col) => col.notNull())
			.addColumn("gateway", "text", (col) => col.notNull())
			.addColumn("refund_ref", "text")
			.addColumn("reason", "text")
			.addColumn("refunded_by", "text", (col) => col.notNull())
			.addColumn("idempotency_key", "text", (col) => col.notNull().unique())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		await sql`CREATE INDEX refunds_order_idx ON refunds (order_id, created_at, id)`.execute(db);
	},
};
