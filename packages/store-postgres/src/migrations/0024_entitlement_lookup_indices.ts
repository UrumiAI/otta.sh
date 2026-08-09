import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Forward-only migration adding the two missing entitlement-lookup indices.
 * Never edit a shipped migration — correct forward.
 *
 * `KyselyEntitlementStore#check` is the delivery gate (no active row ⇒ the file
 * is not served) and compiles one predicate shape: `state = ? AND sku = ?`,
 * plus AT LEAST ONE of `order_id = ?` (the download capability carried by an
 * unguessable order id) and `lower(buyer_ref) = ?` (the session scope, folded
 * because a lower-normalized session email must match a mixed-case checkout
 * ref). A query with neither scope is refused before it reaches SQL. Until now
 * `entitlements` carried only two implicit indexes — the primary key and the
 * UNIQUE on `grant_idempotency_key` — neither of which touches any axis of that
 * predicate, so every check was a full scan.
 *
 * - `idx_entitlements_buyer_ref_lower` — `(lower(buyer_ref), sku, state)`. The
 *   leading term is FUNCTIONAL: the compare side is folded at every call site,
 *   so a plain b-tree on `buyer_ref` would never be chosen by the planner. The
 *   expression is spelled exactly as `check` spells it, so a rewrite to a
 *   different fold stops matching, which `entitlement-lookup-indices.test.ts`
 *   catches by explaining the store's own compiled statement.
 * - `idx_entitlements_order_id` — `(order_id, sku, state)`, the same three
 *   equality terms with the other scope leading.
 *
 * Why the SCOPE column leads, not `sku`: all four terms are equalities, so a
 * b-tree turns each into a boundary condition regardless of position — position
 * only decides which queries can use the index at all, and how much of it they
 * must walk. `sku` is the least selective axis (every buyer of one product
 * shares it, and that set grows with the product's popularity, unboundedly),
 * while entries per order and per buyer are bounded by cart size and by how
 * much one person has bought. Leading with the scope makes each check a point
 * lookup.
 *
 * Why TWO indices rather than one composite: a b-tree can only be probed from
 * its leading column, and neither scope query mentions the other's column —
 * the order-scope check has no `buyer_ref` term at all. A single
 * `(sku, state, lower(buyer_ref), order_id)` therefore serves one shape by
 * point lookup and the other by walking the whole `(sku, state)` range with the
 * scope applied as a non-boundary qual. Measured at 60k rows over 50 skus, the
 * order-scope check touched 14 buffers on the single composite versus 4 on this
 * pair, and that gap widens linearly with entitlements granted per sku.
 *
 * Why `state` is a COLUMN and not a partial `WHERE state = 'active'` predicate:
 * `check` binds the state as a PARAMETER (`state = $1`), and Postgres can only
 * prove a partial index's predicate from a parameter once that parameter has
 * been folded to a constant — which happens under a custom plan but not under a
 * generic one. Verified against a partial form: the same statement planned as
 * `Bitmap Index Scan` with a custom plan and fell back to `Seq Scan` under
 * `plan_cache_mode = force_generic_plan`. That is a regression an EXPLAIN test
 * cannot see (it always plans custom), so the state axis is carried as an
 * ordinary trailing column, which is a boundary condition in every plan mode.
 * It is trailing rather than leading because two distinct values narrow almost
 * nothing on their own. Contrast `0022`'s `idx_orders_customer_id`, whose
 * partial `WHERE customer_id IS NOT NULL` is provable from `customer_id = $1`
 * structurally, independent of the parameter's value.
 *
 * Safe on a populated table: both are additive `CREATE INDEX … IF NOT EXISTS`
 * statements — no rewrite, no constraint, no data change. No `CONCURRENTLY`,
 * matching the `0008`/`0009`/`0022` precedent: the migration runner wraps each
 * migration in a transaction, inside which `CREATE INDEX CONCURRENTLY` cannot
 * run on Postgres.
 *
 * SQLite: no dialect fork. Expression indices (3.9.0) and the portable column
 * form both apply, `lower()` is spelled identically on both dialects — the same
 * claim `check` itself already relies on — and SQLite resolves the same two
 * `SEARCH … USING INDEX` plans for the three real predicate shapes. The
 * functional leading term uses a raw `sql` fragment because the builder has no
 * typed API for an expression column, so it is NOT a portable-builder construct;
 * it emits identical DDL on both dialects only because this particular
 * expression is spelled the same on both.
 */
export const migration0024EntitlementLookupIndices: Migration = {
	async up(db: Kysely<unknown>): Promise<void> {
		await db.schema
			.createIndex("idx_entitlements_buyer_ref_lower")
			.ifNotExists()
			.on("entitlements")
			// Chained `.column()` rather than one `.columns([…])`: the array
			// overload infers its column-name generic from the literals it is
			// given, so mixing an `Expression` in with them fails to type.
			.column(sql`lower(buyer_ref)`)
			.column("sku")
			.column("state")
			.execute();

		await db.schema
			.createIndex("idx_entitlements_order_id")
			.ifNotExists()
			.on("entitlements")
			.columns(["order_id", "sku", "state"])
			.execute();
	},
};
