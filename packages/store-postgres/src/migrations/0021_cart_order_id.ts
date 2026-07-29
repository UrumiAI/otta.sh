import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration for issue #132: `carts.order_id` — the order a cart
 * successfully handed off to. `CartStore.checkout` writes it in the SAME guarded
 * statement that flips `state` to `checked_out`, so the two are never observable
 * apart and the existing `WHERE state = 'active'` predicate is already the CAS
 * that makes the stamp write-once.
 *
 * Deliberately just the column:
 *   - **No backfill.** The project is unreleased; there is no production data,
 *     and every existing `checked_out` cart predates the writer.
 *   - **No FK to `orders`.** `orders.cart_id` — the reverse edge — is itself
 *     unconstrained text, and `ADD COLUMN … REFERENCES` does not port to
 *     better-sqlite3, which runs the same DDL.
 *   - **No index.** Every cart read is by primary key.
 *   - **No CHECK constraint** tying the column to `state`. The
 *     "`active` ⟺ no order id" invariant is enforced by `checkout` being the
 *     column's single writer, NOT structurally — a raw partial UPDATE can still
 *     produce a `checked_out` cart with a NULL order id, and
 *     `cart-fence.dialects.test.ts` constructs exactly that on purpose so the
 *     cart-state fence stays provably independent of this column.
 */
export const migration0021CartOrderId: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema.alterTable("carts").addColumn("order_id", "text").execute();
	},
};
