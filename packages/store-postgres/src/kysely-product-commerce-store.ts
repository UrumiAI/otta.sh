import {
	cents,
	currency,
	idempotencyKey as toIdempotencyKey,
	InvalidLowStockThresholdError,
	isValidLowStockThreshold,
	MissingProductIdError,
	MissingVariantKeyError,
	money,
	productId as toProductId,
	sku as toSku,
	SkuConflictError,
	SkuHeldStockError,
	SkuStockConflictError,
	type Clock,
	type IdempotencyKey,
	type InventoryPolicy,
	type ProductCommerce,
	type ProductCommerceStore,
	type ProductCommerceView,
	type ProductId,
	type ProductKind,
	type ProductListFilter,
	type ProductCommerceUpdateResult,
	type ProductListPage,
	type ProductListResult,
	type ProductSummary,
	type ProductVariant,
	type ProductVariantSummary,
	type ProductVariantUpdateResult,
	type UpdateProductCommerceFieldsInput,
	type UpdateProductVariantFieldsInput,
	type UpsertProductCommerceInput,
	type UpsertProductVariantInput,
} from "@otta-sh/domain";
import {
	type Expression,
	expressionBuilder,
	type ExpressionBuilder,
	type Kysely,
	sql,
	type SqlBool,
} from "kysely";
import type { Database, ProductCommerceTable, ProductVariantsTable } from "./schema.js";

export interface KyselyProductCommerceStoreOptions {
	db: Kysely<Database>;
	clock: Clock;
}

/**
 * `ProductCommerceStore` over Kysely (Phase 1 step 4), dialect-agnostic
 * across better-sqlite3 and pg.
 *
 * `upsert` is ONE conditional statement WHEN THE INPUT CARRIES NO `sku` — the
 * shape it has always had, and still the shape of every CMS-sync save (the
 * sync writes title and watermark only). An input that DOES carry a sku may be
 * a rename, and a rename is a stock movement that has to commit with the row,
 * so that path opens a transaction and runs THE SKU-RENAME RULE inside it (see
 * the port doc, and `#carrySkuStock` below). The conditional statement itself
 * is unchanged in either case: an
 * `INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE <guards>` with two
 * guards ANDed together:
 *  1. replay dedupe — `product_commerce.idempotency_key != :key` (per-row
 *     compare-on-write, plan §4 — deliberately NOT a global unique
 *     constraint);
 *  2. sync ordering (review S1) — `excluded.content_updated_at IS NULL OR
 *     product_commerce.content_updated_at IS NULL OR
 *     excluded.content_updated_at >= product_commerce.content_updated_at`:
 *     a sync carrying a STRICTLY OLDER content watermark than the stored one
 *     is a stale no-op (out-of-order hook delivery converges); panel saves
 *     (no watermark ⇒ excluded is NULL) always pass — explicit merchant
 *     intent is last-writer-wins, the documented lost-update semantics.
 * ISO-8601 text compares lexicographically = chronologically, identically on
 * both dialects.
 *
 * Fields omitted from the input (`undefined`) resolve to the EXISTING column
 * via the `product_commerce.<col>` reference in the SET list rather than
 * `excluded.<col>`, so a partial upsert never clobbers fields it didn't
 * touch. When a WHERE guard makes the statement a no-op (same-key replay or
 * stale sync), `RETURNING` yields no row, and the current row is re-read
 * with one follow-up `SELECT`.
 *
 * CONCURRENCY, on the sku-bearing path only: the rename carry moves real units,
 * so it IS a race target, and `test/sku-rename-race.pg.test.ts` covers it on
 * Postgres (concurrent renames through both writers, a rename against the seed
 * that can contend its claim, and a rename against a restock of the sku it is
 * leaving). The no-sku path is unchanged and remains none of that.
 *
 * Live-sku uniqueness is the migration's partial unique index
 * (`UNIQUE (sku) WHERE deleted_at IS NULL`, review S3) — the `ON CONFLICT`
 * target stays the `product_id` PK, so the partial index never arbitrates
 * the upsert; a genuinely conflicting live sku surfaces as a constraint
 * error on both dialects, and a soft-deleted row's sku is reusable.
 *
 * ─── THE LOCK ORDER ────────────────────────────────────────────────────────
 *
 * The VARIANT writers take row locks in one order, and this is the only place it
 * is written down:
 *
 *     product_commerce  →  inventory, IN SKU ORDER  →  product_variants
 *
 * Skipping a stage is always allowed; taking one out of order is not.
 *
 * WHAT IS ACTUALLY PROVED, stated as the obligation rather than as a slogan,
 * because "one total order" is stronger than what holds here:
 *  1. Every variant writer that will APPLY takes the parent's lock first — except
 *     the single-lock writer in (2), which needs no ordering to be safe. Two
 *     writers under one product therefore never interleave at all, which makes
 *     every intra-product cycle unreachable rather than merely ordered — including
 *     the one inside `product_variants_live_sku_unique`.
 *  2. Writers that take at most ONE lock cannot participate in a cycle, since a
 *     cycle needs someone waiting while holding. `deactivateVariant` is a single
 *     conditional UPDATE and is in that class.
 *  3. Across DIFFERENT parents, the only shared resources are `inventory` rows,
 *     and those are taken in sorted sku order by every writer that takes two.
 *  4. The `couldApply`-FALSE branch of `updateVariantFields` skips the parent lock
 *     and so is outside (1). It is cycle-free only because such an edit never
 *     applies, and THAT rests on the monotonic-clock assumption named on
 *     `updateVariantFields` — the same assumption its guard 4b already rests on.
 *     If that assumption is ever false, this branch is the second thing to fix.
 *  5. `#applyVariantDeclare` is the one deliberate inversion: it cannot know which
 *     sku to lock until it has read the row, so it takes the parent, then the
 *     variant row, then at most ONE `inventory` row. It never holds two stock rows,
 *     and every writer that could wait on its variant row holds the parent it
 *     already owns — so it closes no cycle. Raced directly against a price edit of
 *     the SAME variant in the variant race suite.
 *
 * WHY THIS ORDER, rather than any other:
 *  - `product_commerce` FIRST because it is the aggregate root — a product's
 *    currency is a fact about the product, so both the product's own repricing
 *    and any variant's pricing have to agree under one lock.
 *  - `inventory` before `product_variants`, which is the opposite of what the
 *    reading order suggests and is the whole lesson of this class. A variant's
 *    guarded UPDATE looks like the decision that precedes the movement, but
 *    writing a sku also takes an entry in `product_variants_live_sku_unique`,
 *    and two writers crossing skus each end up waiting on the other's
 *    uncommitted index entry — a cycle formed inside the index, before either
 *    has touched a stock row.
 *  - `inventory` rows IN SKU ORDER — sorted, never by role. A carry touches two
 *    of them, and which is "source" and which is "target" belongs to the caller
 *    rather than to the rows: two crossing renames, X→Y and Y→X, disagree about
 *    role order on the same pair, so ordering by role is ordering by nothing and
 *    they deadlock (measured: `40P01` around one loop in 250). Sorting gives every
 *    writer one agreed order over any pair.
 *
 * KNOWN, PRE-EXISTING, AND NOT ADDRESSED HERE: the PRODUCT-side writers have the
 * same exposure this order closes for variants, and it predates variants. `upsert`
 * and `#applyCommerceFields` write `sku` in their guarded statement, which takes
 * an entry in `product_commerce_live_sku_unique`, BEFORE any `inventory` lock — so
 * two products renaming onto each other's skus can deadlock inside that index
 * exactly as two variants could. Restructuring them is deliberately out of scope
 * for the change that introduced variants: it touches the two writers the whole
 * catalog runs through, and it deserves its own change and its own race. Recorded
 * so the next reader finds a known follow-up rather than an oversight.
 *
 * WHY IT IS WRITTEN DOWN RATHER THAN INFERRED. Every lock here is a portable
 * self-assignment `UPDATE` (`FOR UPDATE` is not SQLite), so the locks are
 * invisible at the call sites that need them and are easy to add in the wrong
 * place. A violation does not fail a unit test: better-sqlite3 serializes every
 * writer onto one connection and cannot deadlock at all, so an inversion is
 * green on the fast tier and surfaces only on Postgres, as an unmapped `40P01`
 * reaching a merchant instead of the typed refusal this port documents. The
 * race suites (`test/sku-rename-race.pg.test.ts`,
 * `test/variant-sku-rename-race.pg.test.ts`) are where that is caught, and each
 * inversion this order rules out has a case named after it.
 */
export class KyselyProductCommerceStore implements ProductCommerceStore {
	readonly #db: Kysely<Database>;
	readonly #clock: Clock;

	constructor(options: KyselyProductCommerceStoreOptions) {
		this.#db = options.db;
		this.#clock = options.clock;
	}

	async upsert(input: UpsertProductCommerceInput, key: IdempotencyKey): Promise<ProductCommerce> {
		if (typeof input.productId !== "string" || input.productId.length === 0) {
			throw new MissingProductIdError();
		}
		// No sku in play ⇒ no rename is possible ⇒ the statement stays exactly
		// what it was, on the plain connection. Only a write that could move the
		// sku pays for a transaction (the CMS sync, which is every upsert on the
		// hot path, never carries one).
		if (input.sku === undefined) return this.#applyUpsert(this.#db, input, key, null);
		return this.#db.transaction().execute(async (trx) => {
			// The row's sku BEFORE the write — half of THE SKU-RENAME RULE's input,
			// read THROUGH THE ROW LOCK rather than with a plain SELECT.
			//
			// This is load-bearing, and a plain SELECT here is a silent-stranding
			// bug. `upsert` has no compare-and-set: under READ COMMITTED a peer that
			// renames the same product between the read and the `ON CONFLICT DO
			// UPDATE` is simply waited for and then written over, so the carry would
			// run against a sku that is no longer the row's. Concretely — this tx
			// reads A, a peer commits A→B (units follow to B), this tx then applies
			// sku=C and carries A(now empty)→C, leaving the units orphaned under B
			// with no error raised: exactly the loss this rule exists to prevent.
			// Taking the lock on the read makes the peer's rename either entirely
			// before us (so we read B and carry B→C) or entirely after.
			//
			// A self-assignment UPDATE is how you take that lock portably —
			// `FOR UPDATE` is not SQLite. Assigning `product_id` to itself touches
			// no observable column, and in particular leaves `updated_at` alone, so
			// the replay and watermark guards below still see exactly what they did.
			const before = await trx
				.updateTable("product_commerce")
				.set((eb) => ({ product_id: eb.ref("product_id") }))
				.where("product_id", "=", input.productId)
				.returning("sku")
				.executeTakeFirst();
			return this.#applyUpsert(trx, input, key, before?.sku ?? null);
		});
	}

	/**
	 * `upsert`'s statement, on whichever executor the caller opened (the plain
	 * connection, or the transaction a sku change needs). `beforeSku` is the
	 * row's sku as it stood before this write, or null when there was no row /
	 * no sku; the carry compares it against the RESOLVED row, so the upsert's
	 * own no-op branches (same-key replay, stale watermark) move nothing without
	 * needing to know they were no-ops.
	 */
	async #applyUpsert(
		exec: Kysely<Database>,
		input: UpsertProductCommerceInput,
		key: IdempotencyKey,
		beforeSku: string | null,
	): Promise<ProductCommerce> {
		const now = this.#clock.now().toISOString();
		const hasSku = input.sku !== undefined;
		const hasPrice = input.price !== undefined;
		const hasTitle = input.title !== undefined;
		const hasTaxClass = input.taxClass !== undefined;
		const hasWeightGrams = input.weightGrams !== undefined;
		const hasLengthMm = input.lengthMm !== undefined;
		const hasWidthMm = input.widthMm !== undefined;
		const hasHeightMm = input.heightMm !== undefined;
		const hasProductKind = input.productKind !== undefined;
		const hasContentUpdatedAt = input.contentUpdatedAt !== undefined;

		let row: ProductCommerceTable | undefined;
		try {
			row = await exec
				.insertInto("product_commerce")
				.values({
					product_id: input.productId,
					sku: input.sku ?? null,
					price_cents: input.price?.amount ?? null,
					price_currency: input.price?.currency ?? null,
					title: input.title ?? null,
					tax_class: input.taxClass ?? null,
					// compare-at / cost / inventory-policy are EDIT-ONLY (never a
					// CMS-sync upsert field) — a NEW row starts at defaults, and a later
					// upsert PRESERVES them by omitting them from the DO UPDATE SET below.
					compare_at_cents: null,
					compare_at_currency: null,
					unit_cost_cents: null,
					unit_cost_currency: null,
					inventory_policy: "deny",
					weight_grams: input.weightGrams ?? null,
					length_mm: input.lengthMm ?? null,
					width_mm: input.widthMm ?? null,
					height_mm: input.heightMm ?? null,
					product_kind: input.productKind ?? "physical",
					active: 0,
					deleted_at: null,
					idempotency_key: key,
					content_updated_at: input.contentUpdatedAt ?? null,
					active_updated_at: null,
					created_at: now,
					updated_at: now,
				})
				.onConflict((oc) =>
					oc
						.column("product_id")
						.doUpdateSet((eb) => ({
							sku: hasSku ? eb.ref("excluded.sku") : eb.ref("product_commerce.sku"),
							price_cents: hasPrice
								? eb.ref("excluded.price_cents")
								: eb.ref("product_commerce.price_cents"),
							price_currency: hasPrice
								? eb.ref("excluded.price_currency")
								: eb.ref("product_commerce.price_currency"),
							title: hasTitle ? eb.ref("excluded.title") : eb.ref("product_commerce.title"),
							tax_class: hasTaxClass
								? eb.ref("excluded.tax_class")
								: eb.ref("product_commerce.tax_class"),
							weight_grams: hasWeightGrams
								? eb.ref("excluded.weight_grams")
								: eb.ref("product_commerce.weight_grams"),
							length_mm: hasLengthMm
								? eb.ref("excluded.length_mm")
								: eb.ref("product_commerce.length_mm"),
							width_mm: hasWidthMm
								? eb.ref("excluded.width_mm")
								: eb.ref("product_commerce.width_mm"),
							height_mm: hasHeightMm
								? eb.ref("excluded.height_mm")
								: eb.ref("product_commerce.height_mm"),
							product_kind: hasProductKind
								? eb.ref("excluded.product_kind")
								: eb.ref("product_commerce.product_kind"),
							idempotency_key: eb.ref("excluded.idempotency_key"),
							content_updated_at: hasContentUpdatedAt
								? eb.ref("excluded.content_updated_at")
								: eb.ref("product_commerce.content_updated_at"),
							updated_at: eb.ref("excluded.updated_at"),
						}))
						// Guard 1: same-key replay is a no-op.
						.where("product_commerce.idempotency_key", "!=", key)
						// Guard 2 (review S1): a strictly-older sync watermark is a stale
						// no-op; NULL on either side (panel save / never-synced row)
						// passes. Raw SQL for the excluded-vs-row comparison — portable
						// text comparison on both dialects.
						.where(
							sql<SqlBool>`(excluded.content_updated_at is null or product_commerce.content_updated_at is null or excluded.content_updated_at >= product_commerce.content_updated_at)`,
						),
				)
				.returningAll()
				.executeTakeFirst();
		} catch (err) {
			// Review F2: surface a LIVE-sku uniqueness conflict (the partial
			// index) as the structured domain error, never an opaque 500. The
			// match is narrowly scoped to THIS constraint (mirroring Phase 0's
			// FK catch) — any other violation still propagates untouched.
			if (input.sku !== undefined && isLiveSkuUniqueViolation(err)) {
				throw new SkuConflictError(input.sku);
			}
			throw err;
		}

		const resolved = row ?? (await this.#selectByProductId(input.productId, exec));
		if (resolved === undefined) {
			throw new Error(`product_commerce upsert lost its row for product_id ${input.productId}`);
		}
		const renaming = beforeSku !== null && resolved.sku !== null && resolved.sku !== beforeSku;
		// The RECIPROCAL half of "a sku names one live sellable unit" (port doc):
		// the partial index covers product↔product, and this covers product↔variant,
		// which no index can. `row !== undefined` is the "the statement applied"
		// witness, so a same-key replay or a stale-watermark no-op refuses nothing —
		// the same position the index occupies. Inside the sku-bearing path's own
		// transaction, so the throw rolls the write back exactly as the index would.
		//
		// BEFORE THE CARRY, and this is a PRECEDENCE decision rather than a locking
		// one (locks are acquired below and above in the class's order regardless;
		// LOCKS ARE NOT CHECKS). Both refusals can apply to one rename — a target sku
		// that another live unit holds will, in production-normal state, also have an
		// `inventory` row, because every applied assignment seeds one. Whichever runs
		// first decides what the operator is told, so the order is fixed rather than
		// incidental: "that sku names another sellable unit" is the actionable truth,
		// and "units are parked under that sku" would be a misleading description of
		// the same state. `SkuConflictError` therefore outranks
		// `SkuStockConflictError` whenever a live unit holds the target.
		if (row !== undefined && input.sku !== undefined) {
			const pair = renaming && beforeSku !== null ? [beforeSku, input.sku].toSorted() : [input.sku];
			for (const s of pair) await this.#lockSkuRowIfPresent(exec, s);
			if (await this.#skuTakenByLiveVariant(exec, input.sku)) {
				throw new SkuConflictError(input.sku);
			}
		}
		// THE SKU-RENAME RULE (port doc), against the row's before/after values — so
		// a same-key replay and a stale-watermark no-op, which both re-read and return
		// the STORED row, compare equal here and move nothing. The carry re-acquires
		// the same sorted pair, which is a no-op now that this path holds it.
		if (renaming && resolved.sku !== null) {
			await this.#carrySkuStock(exec, beforeSku as string, resolved.sku, key);
		}
		return toDomain(resolved);
	}

	/**
	 * THE SKU-RENAME RULE's inventory half (port doc on `ProductCommerceStore`),
	 * on the SAME executor as the product-row write so the rename and the stock
	 * movement commit or roll back together. Portable across both dialects:
	 *
	 *  1. LOCK AND READ the source — a self-assignment `UPDATE … SET on_hand =
	 *     on_hand … RETURNING on_hand`. Reading through an UPDATE rather than a
	 *     SELECT takes the row's write lock for the rest of the transaction
	 *     (portably — `FOR UPDATE` is not SQLite), so the count read here cannot
	 *     move under a concurrent reserve/restock/removal before step 4 zeroes
	 *     it, which is exactly how units would go missing. Taking it FIRST also
	 *     serializes this whole carry against `reserve`, whose guarded decrement
	 *     needs the same lock — so the hold check below cannot be outrun by a
	 *     reservation landing a moment later. No row ⇒ nothing to carry.
	 *  2. REFUSE on live holds — `SkuHeldStockError` when any `held`/`adopted`
	 *     reservation still names the source. Their units are already out of
	 *     `on_hand` and the hold cannot follow the rename, so there is nothing
	 *     honest to move; see the port doc for what leaks if this is skipped.
	 *  3. CLAIM the target — `INSERT … ON CONFLICT (sku) DO NOTHING RETURNING`.
	 *     The insert IS the occupancy test, which is what makes it safe under
	 *     concurrency: two creators of one free target cannot both see it free,
	 *     because the second conflicts with the first's uncommitted row (the
	 *     other creator being `seedOnHand`, which every product save attempts —
	 *     pinned in `test/sku-rename-race.pg.test.ts`). Zero rows back ⇒ the sku
	 *     already has an inventory row ⇒ refuse. The test never looks at what
	 *     that row HOLDS, so a row at 0 refuses exactly like a stocked one.
	 *  4. MOVE — the count onto the target, then zero the source, then record the
	 *     pair in the stock-movement ledger. The source row is RETAINED:
	 *     `reservations.sku` references `inventory.sku`, so a sku that has ever
	 *     been reserved can be neither deleted nor re-keyed, and a stock row is
	 *     never deleted regardless.
	 *
	 * `commandKey` is the idempotency key of the product write this carry belongs
	 * to, and the audit rows in step 4 derive their own keys from it. It is not a
	 * uniqueness guarantee — it is client-supplied — so see `#recordCarry` for
	 * what those keys do and do not promise, and why a collision there is
	 * survivable.
	 */
	async #carrySkuStock(
		exec: Kysely<Database>,
		sourceSku: string,
		targetSku: string,
		commandKey: IdempotencyKey,
	): Promise<void> {
		if (sourceSku === targetSku) return;

		// THE PAIR IS ACQUIRED AS A PAIR, IN SKU ORDER — never one role and then the
		// other, which is what deadlocked before this loop existed.
		//
		// A carry touches two `inventory` rows, and which of them is "source" and
		// which is "target" is a property of the CALLER, not of the rows. Two
		// crossing renames — X→Y and Y→X — therefore disagree about role order on
		// the same two rows, so ordering by role is ordering by nothing: each locks
		// its own source and then waits on the other's. It deadlocks even though the
		// claim is an `ON CONFLICT DO NOTHING` that looks lock-free, because a
		// speculative insert must wait on a conflicting tuple another transaction has
		// updated — and the peer's source lock is exactly such an update. Measured:
		// this is a `40P01` roughly one loop in 250, i.e. rare enough to survive
		// review and frequent enough to reach a merchant.
		//
		// Sorting the two skus gives every carry in the system ONE agreed order over
		// any pair, which is the textbook resolution and the only one that does not
		// depend on who called. Rows that do not exist yet lock nothing here; the
		// claim below is still what arbitrates those, via the speculative-insert
		// conflict.
		for (const s of [sourceSku, targetSku].toSorted()) {
			await this.#lockSkuRowIfPresent(exec, s);
		}

		const source = await exec
			.updateTable("inventory")
			.set((eb) => ({ on_hand: eb.ref("on_hand") }))
			.where("sku", "=", sourceSku)
			.returning("on_hand")
			.executeTakeFirst();

		const held = await exec
			.selectFrom("reservations")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.where("sku", "=", sourceSku)
			.where("state", "in", ["held", "adopted"])
			.executeTakeFirst();
		const liveHolds = Number(held?.n ?? 0);
		if (liveHolds > 0) throw new SkuHeldStockError(sourceSku, liveHolds);

		const claimed = await exec
			.insertInto("inventory")
			.values({ sku: targetSku, on_hand: 0 })
			.onConflict((oc) => oc.column("sku").doNothing())
			.returning("sku")
			.executeTakeFirst();
		if (claimed === undefined) throw new SkuStockConflictError(sourceSku, targetSku);

		if (source === undefined || source.on_hand === 0) return;

		await exec
			.updateTable("inventory")
			.set({ on_hand: source.on_hand })
			.where("sku", "=", targetSku)
			.execute();
		await exec.updateTable("inventory").set({ on_hand: 0 }).where("sku", "=", sourceSku).execute();
		await this.#recordCarry(exec, sourceSku, targetSku, source.on_hand, commandKey);
	}

	/**
	 * The carry's AUDIT TRAIL: one row out of the source and one into the target
	 * in `inventory_stock_movements`, written inside the carry's own transaction
	 * so a move can never be durable without its record.
	 *
	 * Every other `on_hand` mutation an operator can trigger already lands in
	 * this ledger (`restock`, `removeStock`); without these two rows a rename
	 * would be the one way to move forty units and leave nothing behind
	 * explaining where they went.
	 *
	 * `rename_out` / `rename_in` are their own directions rather than a reused
	 * `removal` + `restock` pair, so the ledger does not claim a merchant
	 * counted anything: the column is plain text and needs no migration, and
	 * `InventoryStore`'s own paths keep their narrowed `"restock" | "removal"`
	 * signatures, so nothing can mistake a carry row for a replayable movement.
	 * The keys are derived from the command's key, which is unique per command
	 * and never reaches here twice (a replay applies no update, so it never
	 * carries). `qty > 0` is a column CHECK, which is why this is called only
	 * when units actually moved — a rename that carries NOTHING (an empty or
	 * absent source row) writes no ledger entry at all, there being no movement
	 * to record.
	 *
	 * WRITE-ONLY TODAY. Nothing reads these rows yet: no admin screen, report or
	 * endpoint surfaces stock movements, and `InventoryStore`'s own ledger reads
	 * are per-key replay lookups that can never match a `rename_*` key. The trail
	 * exists so the history is already there when something does surface it, and
	 * so a rename stops being the one stock movement that leaves no record; a
	 * movements view is a separate change.
	 */
	async #recordCarry(
		exec: Kysely<Database>,
		sourceSku: string,
		targetSku: string,
		qty: number,
		commandKey: IdempotencyKey,
	): Promise<void> {
		const at = this.#clock.now().toISOString();
		await exec
			.insertInto("inventory_stock_movements")
			.values([
				{
					idempotency_key: `${commandKey}:sku-rename:out:${sourceSku}`,
					sku: sourceSku,
					direction: "rename_out",
					qty,
					outcome: "ok",
					result_on_hand: 0,
					created_at: at,
				},
				{
					idempotency_key: `${commandKey}:sku-rename:in:${targetSku}`,
					sku: targetSku,
					direction: "rename_in",
					qty,
					outcome: "ok",
					result_on_hand: qty,
					created_at: at,
				},
			])
			// THE AUDIT ROW MUST NEVER FAIL THE MOVE IT DESCRIBES. These keys derive
			// from `commandKey`, which is client-supplied (the wire's
			// `Idempotency-Key`), so this primary key is not ours to guarantee: a
			// client reusing one key across two renames of the SAME source sku, or a
			// caller crafting a `restock` key that happens to equal one of these,
			// would otherwise abort a perfectly legal rename with a raw unique
			// violation. DO NOTHING makes that pathological case cost the audit row
			// rather than the merchant's rename. Pinned in
			// `test/sku-rename-ledger.dialects.test.ts`.
			.onConflict((oc) => oc.doNothing())
			.execute();
	}

	async getByProductId(productId: ProductId): Promise<ProductCommerce | null> {
		const row = await this.#selectByProductId(productId);
		return row === undefined ? null : toDomain(row);
	}

	/**
	 * Bulk snapshot read (port doc): the batch companion to `getByProductId`,
	 * ONE `SELECT … WHERE product_id IN (:ids)` so the two checkout paths fetch
	 * every cart line's projection in a single round trip instead of one per
	 * line (the per-cart-line N+1 this method kills).
	 *
	 * The RAW row read — `selectAll()`, NO inventory join, NO deleted_at / sku /
	 * price guards (identical row semantics to `getByProductId`, deliberately
	 * NOT `listCommerceByIds`): each row goes through the same `toDomain`, which
	 * reads only `product_commerce` columns, so no join is needed. Missing ids
	 * are simply absent from the Map; `IN` collapses duplicates (one row per
	 * PK); no ORDER BY. The empty id list short-circuits without touching the DB
	 * (`IN ()` is not SQL).
	 */
	async getManyByProductId(productIds: ProductId[]): Promise<Map<ProductId, ProductCommerce>> {
		if (productIds.length === 0) return new Map();
		const rows = await this.#db
			.selectFrom("product_commerce")
			.selectAll()
			.where("product_commerce.product_id", "in", productIds)
			.execute();

		const result = new Map<ProductId, ProductCommerce>();
		for (const row of rows) {
			result.set(toProductId(row.product_id), toDomain(row));
		}
		return result;
	}

	/**
	 * Batch catalog read (Phase 2 §6/§7 step 2): ONE statement —
	 * `product_commerce LEFT JOIN inventory ON inventory.sku =
	 * product_commerce.sku WHERE product_id IN (:ids) AND <commerce-complete
	 * guards>` — identical on both dialects; no interactive transaction (a
	 * read, but the single-statement discipline holds).
	 *
	 * INVARIANT (do not weaken — see the port doc): `inStock` (`on_hand > 0`,
	 * LEFT JOIN so a missing inventory row reads as out-of-stock, never a
	 * dropped product) is computed HERE, in the same statement — never split
	 * into a separate inventory query. Pinned by the query-count test in
	 * `test/product-commerce-batch.dialects.test.ts`.
	 *
	 * Missing/soft-deleted/commerce-incomplete ids are simply absent from the
	 * result; `IN` collapses duplicates; no ORDER BY (no guaranteed order).
	 * Inactive rows are RETURNED with `active: false` — the purchasability
	 * gate is the plugin's `joinProduct`, not the store (port doc). The empty
	 * id list short-circuits without touching the DB (`IN ()` is not SQL).
	 */
	async listCommerceByIds(productIds: ProductId[]): Promise<ProductCommerceView[]> {
		if (productIds.length === 0) return [];
		const rows = await this.#db
			.selectFrom("product_commerce")
			.leftJoin("inventory", "inventory.sku", "product_commerce.sku")
			.select([
				"product_commerce.product_id",
				"product_commerce.sku",
				"product_commerce.price_cents",
				"product_commerce.price_currency",
				"product_commerce.active",
				"inventory.on_hand",
			])
			.where("product_commerce.product_id", "in", productIds)
			.where("product_commerce.deleted_at", "is", null)
			.where("product_commerce.sku", "is not", null)
			.where("product_commerce.price_cents", "is not", null)
			.where("product_commerce.price_currency", "is not", null)
			.execute();

		return rows.map((row) => {
			// The WHERE guards make these non-null; the narrowing is for the
			// type system, with a loud failure if the query ever drifts.
			if (row.sku === null || row.price_cents === null || row.price_currency === null) {
				throw new Error(
					`listCommerceByIds returned a commerce-incomplete row for product_id ${row.product_id}`,
				);
			}
			return {
				productId: toProductId(row.product_id),
				sku: toSku(row.sku),
				price: money(cents(row.price_cents), currency(row.price_currency)),
				inStock: (row.on_hand ?? 0) > 0,
				active: row.active === 1,
			};
		});
	}

	async softDelete(productId: ProductId, key: IdempotencyKey): Promise<void> {
		const now = this.#clock.now().toISOString();
		await this.#db
			.updateTable("product_commerce")
			.set({ active: 0, deleted_at: now, idempotency_key: key, updated_at: now })
			.where("product_id", "=", productId)
			.where("deleted_at", "is", null)
			.execute();
	}

	/**
	 * Guarded admin edit (port doc): a conditional `UPDATE` under an optimistic
	 * compare-and-set — the atomic mirror of the fake's guard chain. It is the
	 * WHOLE statement list only when the input carries no `sku`; an edit that
	 * could rename runs in a transaction alongside THE SKU-RENAME RULE's stock
	 * movement, exactly as `upsert` does (see the class doc).
	 * The applying statement ANDs the guards: `product_id = :id`, `deleted_at IS
	 * NULL`, `updated_at = :expectedUpdatedAt` (the CAS), `idempotency_key !=
	 * :key` (replay dedupe), and — only when a price is supplied — a currency-
	 * integrity guard (`price_currency IS NULL OR price_currency = :cur`). Fields
	 * omitted from `input` are absent from the SET clause, so they are preserved
	 * (the plain-UPDATE analogue of `upsert`'s excluded-vs-row SET).
	 *
	 * When the UPDATE applies, `RETURNING` yields the row → `ok`. When it matches
	 * ZERO rows (some guard failed), a follow-up `SELECT` classifies the no-op in
	 * the SAME order the fake does — not_found (missing / soft-deleted) FIRST,
	 * then replay (stored key == key), then stale (updatedAt moved), then
	 * currency_mismatch (see the port doc: not_found outranks replay, so a
	 * same-key replay after a soft delete is not_found on every adapter) —
	 * mirroring `upsert`'s no-op-then-reread pattern. A lost concurrent edit
	 * surfaces deterministically as `stale`, never a torn write.
	 *
	 * The FIELD edit is still not an oversell-style race target; the rename that
	 * may ride along with it IS, and is covered on Postgres by
	 * `test/sku-rename-race.pg.test.ts`. Unlike `upsert`, the before-read this
	 * path feeds the carry needs no lock of its own: the CAS already collapses an
	 * interleaved write into `stale`, so a carry can only run against the sku the
	 * applying statement matched. Live-sku collisions surface as
	 * `SkuConflictError`, exactly like `upsert`.
	 */
	async updateCommerceFields(
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductCommerceUpdateResult> {
		// As in `upsert`: neither a sku (which may rename) nor a price (whose
		// currency the live variants get a say in) ⇒ the edit stays the single
		// statement it has always been, on the plain connection.
		if (input.sku === undefined && input.price === undefined) {
			return this.#applyCommerceFields(this.#db, input, key, expectedUpdatedAt, null, []);
		}
		return this.#db.transaction().execute(async (trx) => {
			// Clause 4c reads `product_variants`, and the variant path reaches that
			// table only AFTER locking this same parent row. So this path takes the
			// parent lock FIRST — stage one of the class lock order — and only then
			// reads. Reading before the lock is the inversion that lets a product
			// repricing and a variant pricing each see the other's "before" state and
			// both apply; it is not merely a weaker guard, it is no guard at all.
			//
			// Taken only when a price is in play: a sku-only edit consults no variant
			// currencies, so it has nothing to serialize against and keeps the shape it
			// has always had. The lock is a self-assignment UPDATE that touches no
			// observable column, so the guarded UPDATE below still sees exactly what it
			// did — in particular `updated_at` is untouched, so the CAS is unaffected.
			if (input.price !== undefined) {
				await trx
					.updateTable("product_commerce")
					.set((eb) => ({ product_id: eb.ref("product_id") }))
					.where("product_id", "=", input.productId)
					.execute();
			}
			const before = await trx
				.selectFrom("product_commerce")
				.select("sku")
				.where("product_id", "=", input.productId)
				.executeTakeFirst();
			const variantCurrencies =
				input.price === undefined ? [] : await this.#liveVariantCurrencies(trx, input.productId);
			return this.#applyCommerceFields(
				trx,
				input,
				key,
				expectedUpdatedAt,
				before?.sku ?? null,
				variantCurrencies,
			);
		});
	}

	/**
	 * `updateCommerceFields`'s statement and its zero-row classifier, on
	 * whichever executor the caller opened. `beforeSku` is the row's sku as it
	 * stood before this edit; the carry runs ONLY on the applying branch, which
	 * is what keeps every zero-row outcome — including the replay `ok` — free of
	 * stock movement.
	 *
	 * Reading `beforeSku` before the guarded UPDATE is safe for the same reason
	 * the edit itself is: the UPDATE only applies while `updated_at` still equals
	 * `expectedUpdatedAt`, and every writer advances it, so an interleaved write
	 * turns this into a `stale` no-op rather than a carry against a sku that has
	 * since moved.
	 */
	async #applyCommerceFields(
		exec: Kysely<Database>,
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
		beforeSku: string | null,
		variantCurrencies: string[],
	): Promise<ProductCommerceUpdateResult> {
		const now = this.#clock.now().toISOString();
		// Clause 4c (port doc): a repricing that would leave a LIVE VARIANT of this
		// product holding another currency. Checked in APP CODE and used to SUPPRESS
		// the statement rather than short-circuit the method — the classifier below
		// still runs, so a replay of a disagreeing edit still reports its replay `ok`
		// and a stale one still reports `stale`, exactly as the guard order requires.
		// Empty for an unvarianted product, so this can never fire on the catalog as
		// it stands.
		const variantCurrencyConflict =
			input.price !== undefined && variantCurrencies.some((c) => c !== input.price?.currency);
		const set: Record<string, string | number | null> = {
			idempotency_key: key,
			updated_at: now,
		};
		if (input.sku !== undefined) set.sku = input.sku;
		if (input.price !== undefined) {
			set.price_cents = input.price.amount;
			set.price_currency = input.price.currency;
		}
		// No `title` branch: the edit input has no `title` field at all (ADR-0013 —
		// the CMS content sync is its sole writer, through `upsert` above).
		if (input.taxClass !== undefined) set.tax_class = input.taxClass;
		if (input.compareAtPrice !== undefined) {
			set.compare_at_cents = input.compareAtPrice === null ? null : input.compareAtPrice.amount;
			set.compare_at_currency =
				input.compareAtPrice === null ? null : input.compareAtPrice.currency;
		}
		if (input.unitCost !== undefined) {
			set.unit_cost_cents = input.unitCost === null ? null : input.unitCost.amount;
			set.unit_cost_currency = input.unitCost === null ? null : input.unitCost.currency;
		}
		if (input.inventoryPolicy !== undefined) set.inventory_policy = input.inventoryPolicy;
		if (input.weightGrams !== undefined) set.weight_grams = input.weightGrams;
		if (input.lengthMm !== undefined) set.length_mm = input.lengthMm;
		if (input.widthMm !== undefined) set.width_mm = input.widthMm;
		if (input.heightMm !== undefined) set.height_mm = input.heightMm;
		if (input.productKind !== undefined) set.product_kind = input.productKind;

		let updated: ProductCommerceTable | undefined;
		// The conflict SUPPRESSES the statement; the classifier below still runs, so
		// guard order is preserved (see the note beside `variantCurrencyConflict`).
		if (!variantCurrencyConflict) {
			try {
				let stmt = exec
					.updateTable("product_commerce")
					.set(set)
					.where("product_id", "=", input.productId)
					.where("deleted_at", "is", null)
					.where("updated_at", "=", expectedUpdatedAt)
					.where("idempotency_key", "!=", key);
				if (input.price !== undefined) {
					// Currency integrity: never silently switch an already-priced row's
					// currency. NULL (first pricing) passes.
					const cur = input.price.currency;
					stmt = stmt.where(sql<SqlBool>`(price_currency is null or price_currency = ${cur})`);
				} else {
					// compare-at / cost supplied WITHOUT a price in the same edit must EACH
					// match the STORED price currency (the row currency) — BOTH fields are
					// guarded INDEPENDENTLY, exactly like the fake's 4b loop (review of PR
					// #70: a single either/or pick here let a "compare-at matches, cost
					// doesn't" edit write a mixed-currency row). A NULL stored price
					// currency FAILS the guard — compare-at / cost require a priced product.
					// (The within-edit currency agreement, when a price IS present, is the
					// use-case's `InvalidProductFieldError` concern, so this branch only
					// runs when price is absent.) A cleared (null) field carries no
					// currency and adds no guard.
					for (const extra of [input.compareAtPrice, input.unitCost]) {
						if (extra != null) {
							const extraCur = extra.currency;
							stmt = stmt.where(
								sql<SqlBool>`(price_currency is not null and price_currency = ${extraCur})`,
							);
						}
					}
				}
				updated = await stmt.returningAll().executeTakeFirst();
			} catch (err) {
				if (input.sku !== undefined && isLiveSkuUniqueViolation(err)) {
					throw new SkuConflictError(input.sku);
				}
				throw err;
			}
		}

		if (updated !== undefined) {
			const renaming = beforeSku !== null && updated.sku !== null && updated.sku !== beforeSku;
			// The RECIPROCAL of the variant writer's cross-table check (port doc):
			// product↔product is the partial index, product↔variant is this. Only the
			// applying branch reaches it, and the throw rolls back inside the
			// sku-bearing path's own transaction.
			//
			// BEFORE THE CARRY — a PRECEDENCE decision, not a locking one. In
			// production-normal state a sku another live unit holds ALSO has an
			// `inventory` row (every applied assignment seeds one), so both refusals
			// apply and whichever runs first is what the operator reads.
			// `SkuConflictError` wins: "that sku names another sellable unit" is
			// actionable, while "units are parked under that sku" describes the same
			// state misleadingly. The sorted pair is acquired here so the check reads
			// under the same locks the carry will re-acquire.
			if (input.sku !== undefined) {
				const pair =
					renaming && beforeSku !== null ? [beforeSku, input.sku].toSorted() : [input.sku];
				for (const s of pair) await this.#lockSkuRowIfPresent(exec, s);
				if (await this.#skuTakenByLiveVariant(exec, input.sku)) {
					throw new SkuConflictError(input.sku);
				}
			}
			// THE SKU-RENAME RULE (port doc) — the applying branch, and only it.
			if (renaming && updated.sku !== null) {
				await this.#carrySkuStock(exec, beforeSku as string, updated.sku, key);
			}
			return { ok: true, product: toDomain(updated) };
		}

		// Zero rows applied — classify the no-op from a fresh read, in the fake's
		// guard order so fake/sqlite/pg agree byte-for-byte.
		const current = await this.#selectByProductId(input.productId, exec);
		if (current === undefined || current.deleted_at !== null) {
			return { ok: false, reason: "not_found" };
		}
		if (current.idempotency_key === key) {
			return { ok: true, product: toDomain(current) }; // replay no-op.
		}
		if (current.updated_at !== expectedUpdatedAt) {
			return { ok: false, reason: "stale", current: toDomain(current) };
		}
		if (
			input.price !== undefined &&
			current.price_currency !== null &&
			current.price_currency !== input.price.currency
		) {
			return { ok: false, reason: "currency_mismatch", current: toDomain(current) };
		}
		// compare-at / cost supplied WITHOUT a price whose currency doesn't match the
		// stored price currency (a null stored currency ⇒ mismatch — the product
		// must be priced first). BOTH fields checked INDEPENDENTLY, mirroring the
		// fake's 4b loop byte-for-byte.
		if (input.price === undefined) {
			for (const extra of [input.compareAtPrice, input.unitCost]) {
				if (extra != null && current.price_currency !== extra.currency) {
					return { ok: false, reason: "currency_mismatch", current: toDomain(current) };
				}
			}
		}
		// 4c, LAST in the currency group so the pre-existing sub-axes keep reporting
		// first and an unvarianted product's classification is byte-identical.
		if (variantCurrencyConflict) {
			return { ok: false, reason: "currency_mismatch", current: toDomain(current) };
		}
		// No guard explains the no-op — the statement should have applied. Fail
		// loudly rather than silently swallow a lost write.
		throw new Error(
			`updateCommerceFields matched zero rows but no guard explains it for product_id ${input.productId}`,
		);
	}

	/**
	 * The afterPublish→activate follow-up (port doc): a single conditional
	 * `UPDATE`, mirroring `softDelete`'s shape. Guards ANDed together:
	 *  - `deleted_at IS NULL` — the load-bearing invariant: a soft-deleted row
	 *    is never resurrected by a publish.
	 *  - `active = 0` — already-active is a stable no-op under replay (leaves
	 *    `updated_at`/`idempotency_key` untouched).
	 *  - the ORDERING guard `active_updated_at IS NULL OR active_updated_at <=
	 *    :t` — a stale, out-of-order publish (a watermark strictly older than
	 *    the one a newer `deactivate` already applied) is a no-op, so a delayed
	 *    `activate` can never re-latch an unpublished product to purchasable.
	 *    NULL (never transitioned) is `-infinity`, so the first flip wins.
	 *    Mirrors `upsert`'s `content_updated_at` guard but over the SEPARATE
	 *    `active_updated_at` column (a `content:afterSave` must not poison the
	 *    gate). A winning flip ADVANCES `active_updated_at` to `:t` so the gate
	 *    stays monotonic (EmDash's publish/unpublish both bump
	 *    content.updatedAt). ISO-8601 text compares lexicographically =
	 *    chronologically, identically on both dialects.
	 * An unknown `product_id` matches zero rows — also a no-op, no row minted.
	 */
	async activate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const now = this.#clock.now().toISOString();
		await this.#db
			.updateTable("product_commerce")
			.set({
				active: 1,
				active_updated_at: contentUpdatedAt,
				idempotency_key: key,
				updated_at: now,
			})
			.where("product_id", "=", productId)
			.where("deleted_at", "is", null)
			.where("active", "=", 0)
			.where(sql<SqlBool>`(active_updated_at is null or active_updated_at <= ${contentUpdatedAt})`)
			.execute();
	}

	/**
	 * The afterUnpublish→deactivate follow-up (port doc): the exact mirror of
	 * `activate` — a single conditional `UPDATE`, guards ANDed together:
	 *  - `deleted_at IS NULL` — a soft-deleted row's tombstone is left
	 *    untouched (never resurrected, never re-stamped by an unpublish).
	 *  - `active = 1` — already-inactive is a stable no-op under replay.
	 *  - the ORDERING guard `active_updated_at IS NULL OR active_updated_at <=
	 *    :t` — a stale, out-of-order unpublish is a no-op, so a delayed
	 *    `deactivate` can never deactivate a row a newer `activate` has since
	 *    re-published. A winning flip advances `active_updated_at` to `:t`.
	 *    (See `activate` for the full watermark rationale.)
	 * An unknown `product_id` matches zero rows — also a no-op, no row minted.
	 * Flips ONLY the publish gate; `deleted_at` is never in the SET clause —
	 * deactivation is not a soft delete.
	 */
	async deactivate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const now = this.#clock.now().toISOString();
		await this.#db
			.updateTable("product_commerce")
			.set({
				active: 0,
				active_updated_at: contentUpdatedAt,
				idempotency_key: key,
				updated_at: now,
			})
			.where("product_id", "=", productId)
			.where("deleted_at", "is", null)
			.where("active", "=", 1)
			.where(sql<SqlBool>`(active_updated_at is null or active_updated_at <= ${contentUpdatedAt})`)
			.execute();
	}

	/**
	 * Admin Products console list (view-only; port doc): ONE statement per page
	 * — `product_commerce` LEFT JOINed to `inventory` for the per-row `onHand`,
	 * never an N+1 of per-row stock reads. `inventory.sku` is that table's
	 * PRIMARY KEY, so the join matches at most one row and can never multiply
	 * the page; the LEFT half is what makes a missing inventory row surface as
	 * `onHand: null` ("unknown"), distinct from `0` ("out of stock"). A NULL
	 * `product_commerce.sku` simply never matches (SQL `NULL = …` is unknown),
	 * which lands on the same `null` — correct, and identical on both dialects.
	 * Measured (pg 16, 5,000 products / 3,997 inventory rows, page 25): p50
	 * 0.43 → 0.58 ms, p95 0.61 → 0.91 ms; an N+1 was 2.60 ms p50. No index was
	 * added — the inner side is already `inventory`'s PK.
	 *
	 * Keyset pagination on `(created_at DESC, product_id DESC)`, byte-for-byte
	 * mirroring `listOrders`: fetch `limit + 1` to detect a next page, emit
	 * `nextCursor` from the last RETURNED row. `created_at` is fixed-width
	 * ISO-8601 text ⇒ lexical order IS chronological, so the raw text
	 * comparisons below are dialect-identical (no casts) across better-sqlite3
	 * and pg. Always excludes soft-deleted rows (port doc).
	 */
	async listProducts(filter: ProductListFilter, page: ProductListPage): Promise<ProductListResult> {
		assertValidLowStockThreshold(filter);
		let q = this.#db
			.selectFrom("product_commerce")
			.leftJoin("inventory", "inventory.sku", "product_commerce.sku")
			.select([
				"product_commerce.product_id as product_id",
				"product_commerce.sku as sku",
				"product_commerce.title as title",
				"product_commerce.price_cents as price_cents",
				"product_commerce.price_currency as price_currency",
				"product_commerce.product_kind as product_kind",
				"product_commerce.active as active",
				"product_commerce.deleted_at as deleted_at",
				"product_commerce.created_at as created_at",
				"inventory.on_hand as on_hand",
			])
			// The tombstone axis (product lifecycle surfacing, port doc): the
			// archive view (`filter.deleted: true`) flips this to `IS NOT NULL`;
			// every other caller (the field omitted or `false`) keeps the
			// ORIGINAL default — only live rows list.
			.where("product_commerce.deleted_at", filter.deleted === true ? "is not" : "is", null);

		const conds = productFilterConditions(filter);
		if (conds.length > 0) q = q.where((eb) => eb.and(conds));
		if (page.cursor !== undefined && page.cursor !== null) {
			const cursor = page.cursor;
			// (created_at < :c) OR (created_at = :c AND product_id < :cid) —
			// everything strictly "after" the cursor position under
			// `created_at DESC, product_id DESC`.
			q = q.where((eb) =>
				eb.or([
					eb("product_commerce.created_at", "<", cursor.createdAt),
					eb.and([
						eb("product_commerce.created_at", "=", cursor.createdAt),
						eb("product_commerce.product_id", "<", cursor.productId),
					]),
				]),
			);
		}

		const rows = await q
			.orderBy("product_commerce.created_at", "desc")
			.orderBy("product_commerce.product_id", "desc")
			.limit(page.limit + 1)
			.execute();

		const hasMore = rows.length > page.limit;
		const returned = hasMore ? rows.slice(0, page.limit) : rows;
		const last = returned.at(-1);
		const nextCursor =
			hasMore && last !== undefined
				? { createdAt: last.created_at, productId: toProductId(last.product_id) }
				: null;

		const products: ProductSummary[] = returned.map((r) => ({
			productId: toProductId(r.product_id),
			sku: r.sku === null ? null : toSku(r.sku),
			title: r.title,
			price:
				r.price_cents === null || r.price_currency === null
					? null
					: money(cents(r.price_cents), currency(r.price_currency)),
			productKind: r.product_kind as ProductKind,
			active: r.active === 1,
			// The LEFT JOIN miss IS the null — `?? null` would be a no-op here,
			// and `?? 0` would be a BUG (it would invent "out of stock" for a
			// product that has no inventory row at all).
			onHand: r.on_hand,
			deletedAt: r.deleted_at,
			createdAt: r.created_at,
		}));
		return { products, nextCursor };
	}

	/**
	 * Count under the SAME predicate as `listProducts` (port doc) — including
	 * the tombstone axis, whose default (live rows only) is applied on the
	 * QUERY rather than inside `productFilterConditions`, so it is restated here
	 * exactly as the list states it.
	 *
	 * NO LEFT JOIN onto `inventory`: the list joins to fill a per-row stock
	 * column, and a count has no columns. Dropping it also keeps the count a
	 * single-table scan on the index the list already uses.
	 *
	 * MEASURED (pg 16, 5,000 products / 3,997 inventory rows, 60 runs), against
	 * the page read it accompanies — the route issues the two CONCURRENTLY:
	 *   unfiltered   count p50 1.26 ms / p95 2.27 ms · page(25) p50 39.3 ms
	 *   active+kind+search  count p50 4.27 ms / p95 5.86 ms · page(25) p50 26.9 ms
	 * The count is 3–16% of the read it rides along with and never its critical
	 * path, so it is NOT gated behind a flag or a first-page-only rule. The
	 * filtered figure is dominated by the same `lower(title) LIKE '%…%'` scan the
	 * LIST already pays for the identical predicate — a functional/trigram index
	 * would speed BOTH up and belongs to search, not to counting. No index was
	 * added for this method. (`countOrders` p50 1.00 ms and `countCoupons` p50
	 * 0.80 ms at the same row count, against 1.14 / 0.60 ms page reads.)
	 */
	async countProducts(filter: ProductListFilter): Promise<number> {
		assertValidLowStockThreshold(filter);
		let q = this.#db
			.selectFrom("product_commerce")
			// Joined back CONDITIONALLY — only `filter.lowStockThreshold`'s
			// predicate needs `inventory.on_hand`; every other axis keeps the
			// join-free plan this method was measured against (port doc).
			.$if(filter.lowStockThreshold !== undefined, (qb) =>
				qb.leftJoin("inventory", "inventory.sku", "product_commerce.sku"),
			)
			.select(sql<number>`count(*)`.as("n"))
			.where("product_commerce.deleted_at", filter.deleted === true ? "is not" : "is", null);
		const conds = productFilterConditions(filter);
		if (conds.length > 0) q = q.where((eb) => eb.and(conds));
		const row = await q.executeTakeFirstOrThrow();
		return Number(row.n);
	}

	/** Count LIVE products referencing a tax class (port doc) — the product half
	 *  of the `deleteTaxClass` delete-in-use guard. One aggregate `SELECT
	 *  COUNT(*)`; excludes soft-deleted rows (a tombstone's tax reference is
	 *  historical, not a live dependency). */
	async countByTaxClass(taxClassId: string): Promise<number> {
		const row = await this.#db
			.selectFrom("product_commerce")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.where("tax_class", "=", taxClassId)
			.where("deleted_at", "is", null)
			.executeTakeFirst();
		return Number(row?.n ?? 0);
	}

	// -- Variants: one commerce row per sellable unit --------------------------

	/**
	 * The CMS-sync declare (port doc): ONE conditional statement — an `INSERT …
	 * ON CONFLICT (product_id, variant_key) DO UPDATE … WHERE <guards>` — on the
	 * plain connection, never a transaction, because this channel CANNOT carry a
	 * sku (the input has no such field) and therefore can never be a stock
	 * movement. That is the whole reason the sync path stays as cheap as the
	 * product-level title sync it rides beside.
	 *
	 * TWO PATHS, decided by an `INSERT … ON CONFLICT DO NOTHING RETURNING *`:
	 *  - A key nobody has declared before INSERTS and is DONE — one statement, no
	 *    transaction, no read. That is the steady-state cost of a new size.
	 *  - A key that already has a row comes back with nothing, and the write then
	 *    runs inside a TRANSACTION, because a resurrect has to REVALIDATE the
	 *    stored commerce facts (port doc) and the revalidation and the row write
	 *    must commit together. Deciding it this way rather than with a preliminary
	 *    SELECT closes the window where a row is orphaned between the look and the
	 *    write: the transaction re-reads THROUGH THE ROW LOCK and decides there.
	 *
	 * The guards mirror `upsert`'s: same-key replay first, then the watermark. The
	 * RESURRECT sits behind a THIRD, narrower guard — presence moves only on a
	 * delivery that carries a watermark AND is strictly newer than the stored one
	 * — which is what makes a redelivered or watermark-less declare unable to undo
	 * an orphan (port doc). The title is not held to it: it is an unordered cache.
	 *
	 * `variant_key` is absent from every SET clause and always will be: it is half
	 * the primary key, it is the identity, and a re-key is a refusal rather than
	 * an update.
	 */
	async upsertVariant(
		input: UpsertProductVariantInput,
		key: IdempotencyKey,
	): Promise<ProductVariant> {
		if (typeof input.productId !== "string" || input.productId.length === 0) {
			throw new MissingProductIdError();
		}
		if (typeof input.variantKey !== "string" || input.variantKey.length === 0) {
			throw new MissingVariantKeyError();
		}
		const now = this.#clock.now().toISOString();

		// A brand-new key: one statement. `sku` is null on a fresh row and NULLs do
		// not collide in a partial unique index, so the PK is the only conflict
		// target and a raw constraint error is unreachable here.
		const inserted = await this.#db
			.insertInto("product_variants")
			.values({
				product_id: input.productId,
				variant_key: input.variantKey,
				// Declared, not priced — this channel has no field for either, so a
				// fresh row is always absent on both (never 0, never "").
				sku: null,
				price_cents: null,
				price_currency: null,
				title: input.title ?? null,
				orphaned_at: null,
				idempotency_key: key,
				content_updated_at: input.contentUpdatedAt ?? null,
				created_at: now,
				updated_at: now,
			})
			.onConflict((oc) => oc.columns(["product_id", "variant_key"]).doNothing())
			.returningAll()
			.executeTakeFirst();
		if (inserted !== undefined) return toVariantDomain(inserted);

		return this.#db.transaction().execute((trx) => this.#applyVariantDeclare(trx, input, key));
	}

	/**
	 * `upsertVariant`'s existing-row path, inside the transaction the resurrect's
	 * revalidation needs.
	 *
	 * FULLY ENROLLED IN THE CLASS LOCK ORDER, because a resurrect is a writer like
	 * any other — it can restore a sku and a price, so it contends with exactly the
	 * writers that assign them:
	 *  1. `product_commerce` (the parent) FIRST, unconditionally on this path. The
	 *     guarded edit reaches the parent before it touches its own variant row, so
	 *     a declare that took the variant row first would be a clean ABBA against a
	 *     price edit of the same variant — one deadlocking as an unmapped `40P01`
	 *     out of the CMS sync, which is the one thing this channel must never do.
	 *     It is taken unconditionally rather than "only when resurrecting" because
	 *     whether this IS a resurrect can only be known after reading the row, and
	 *     reading it means holding it: deciding first and locking second is the
	 *     inversion all over again.
	 *  2. the variant row, read THROUGH its lock — a self-assignment `UPDATE …
	 *     RETURNING *`, the portable form (`FOR UPDATE` is not SQLite), touching no
	 *     observable column so no guard below sees it.
	 *  3. the stored sku's `inventory` row, before the revalidation reads it. That
	 *     is what makes the revalidation an answer rather than a guess: without it a
	 *     concurrent claim of the same sku either lands after our read — leaving two
	 *     live units on one sku when the claimant is a product — or races our own
	 *     restore into a raw `23505` escaping the sync when the claimant is another
	 *     variant. Both are the failures the clearing exists to prevent.
	 *
	 * PERFORMANCE, stated plainly because it is not free: a re-declare is the
	 * STEADY STATE — every CMS save re-declares every key the repeater still
	 * carries — and each one now costs a transaction plus two row locks instead of
	 * one statement. That is the price of a resurrect that cannot corrupt, and it is
	 * paid on an admin-frequency path (a document save), never on a checkout or
	 * catalog read. A first declare of a new key is still the single INSERT above.
	 *
	 * AND THEY SERIALIZE ON THE PARENT. One save re-declaring N keys takes the SAME
	 * `product_commerce` row lock N times, so those N declares run strictly one
	 * after another rather than concurrently, and the save's variant sync is linear
	 * in the number of sizes. For a garment's handful of sizes that is nothing; a
	 * product with hundreds of variants would feel it, and the fix then is to batch
	 * the declares into one transaction that takes the parent once — not to weaken
	 * the lock.
	 */
	async #applyVariantDeclare(
		exec: Kysely<Database>,
		input: UpsertProductVariantInput,
		key: IdempotencyKey,
	): Promise<ProductVariant> {
		// Stage 1: the parent. Matches zero rows when the product row has not synced
		// yet (the documented out-of-order case), which takes nothing and is correct.
		await exec
			.updateTable("product_commerce")
			.set((eb) => ({ product_id: eb.ref("product_id") }))
			.where("product_id", "=", input.productId)
			.execute();

		// Stage 2: the variant row.
		const stored = await exec
			.updateTable("product_variants")
			.set((eb) => ({ product_id: eb.ref("product_id") }))
			.where("product_id", "=", input.productId)
			.where("variant_key", "=", input.variantKey)
			.returningAll()
			.executeTakeFirst();
		if (stored === undefined) {
			// Variant rows are never deleted, so the row that just refused our INSERT
			// cannot have gone. Fail loudly rather than mint a second one.
			throw new Error(
				`product_variants declare lost its row for ${input.productId}/${input.variantKey}`,
			);
		}

		// Guard 1: same-key replay — a provable no-op, ahead of everything else.
		if (stored.idempotency_key === key) return toVariantDomain(stored);
		// Guard 2: a strictly older content revision never overwrites fresher data.
		if (
			input.contentUpdatedAt !== undefined &&
			stored.content_updated_at !== null &&
			input.contentUpdatedAt < stored.content_updated_at
		) {
			return toVariantDomain(stored);
		}

		// PRESENCE moves only on an ordered, strictly newer delivery (port doc).
		const resurrecting =
			stored.orphaned_at !== null &&
			input.contentUpdatedAt !== undefined &&
			(stored.content_updated_at === null || input.contentUpdatedAt > stored.content_updated_at);

		// A resurrect REVALIDATES: an orphan's sku was free for reuse, so it may no
		// longer be there to reclaim, and a price in a currency the product no
		// longer holds is not a price. Cleared, never refused — the declare states a
		// fact about the CMS and cannot be voted down by the commerce row. The
		// `inventory` row is untouched: a cleared sku leaves its stock where it is,
		// and re-assigning it later ADOPTS that row under THE FIRST-SKU ASYMMETRY.
		let sku = stored.sku;
		let priceCents = stored.price_cents;
		let priceCurrency = stored.price_currency;
		if (resurrecting) {
			if (sku !== null) {
				// Stage 3: the sku's stock row, before either read — the same row and
				// the same terms the two assigning writers use, so a claim in flight is
				// waited for and then SEEN rather than missed.
				await this.#lockSkuRowIfPresent(exec, sku);
				if (
					(await this.#skuTakenByLiveVariant(exec, sku, input.variantKey)) ||
					(await this.#skuTakenByLiveProduct(exec, sku))
				) {
					sku = null;
				}
			}
			if (priceCurrency !== null) {
				const productCurrency = await this.#resolveProductCurrency(
					exec,
					input.productId,
					input.variantKey,
				);
				if (productCurrency !== null && productCurrency !== priceCurrency) {
					priceCents = null;
					priceCurrency = null;
				}
			}
		}

		const updated = await exec
			.updateTable("product_variants")
			.set({
				title: input.title !== undefined ? input.title : stored.title,
				sku,
				price_cents: priceCents,
				price_currency: priceCurrency,
				orphaned_at: resurrecting ? null : stored.orphaned_at,
				idempotency_key: key,
				content_updated_at:
					input.contentUpdatedAt !== undefined ? input.contentUpdatedAt : stored.content_updated_at,
				updated_at: this.#clock.now().toISOString(),
			})
			.where("product_id", "=", input.productId)
			.where("variant_key", "=", input.variantKey)
			.returningAll()
			.executeTakeFirstOrThrow();
		return toVariantDomain(updated);
	}

	/**
	 * Every variant of one product (port doc): ONE statement — `product_variants`
	 * LEFT JOINed to `inventory` for the per-row `onHand`, never an N+1 of
	 * per-variant stock reads. `inventory.sku` is that table's PRIMARY KEY, so the
	 * join matches at most one row and can never multiply the result; the LEFT
	 * half is what makes a variant with no inventory row surface as `onHand: null`
	 * ("unknown"), distinct from `0` ("out of stock"). A NULL `sku` simply never
	 * matches, landing on the same null — correct, and identical on both dialects.
	 *
	 * Ordered `variant_key ASC` — the only stable order (see the port doc) —
	 * served by the `(product_id, variant_key)` primary key with no extra index.
	 * Orphaned rows are INCLUDED, flagged by a non-null `orphanedAt`.
	 */
	async listVariants(productId: ProductId): Promise<ProductVariantSummary[]> {
		const rows = await this.#db
			.selectFrom("product_variants")
			.leftJoin("inventory", "inventory.sku", "product_variants.sku")
			.select([
				"product_variants.product_id as product_id",
				"product_variants.variant_key as variant_key",
				"product_variants.sku as sku",
				"product_variants.price_cents as price_cents",
				"product_variants.price_currency as price_currency",
				"product_variants.title as title",
				"product_variants.orphaned_at as orphaned_at",
				"product_variants.created_at as created_at",
				"product_variants.updated_at as updated_at",
				"inventory.on_hand as on_hand",
			])
			.where("product_variants.product_id", "=", productId)
			.orderBy("product_variants.variant_key", "asc")
			.execute();

		// NARROWED: `idempotency_key` and `content_updated_at` are not in the SELECT
		// list at all (port doc — write-path bookkeeping a reader never needs), so
		// the projection cannot leak them by accident. `updated_at` stays: it is the
		// compare-and-set watermark an editor passes back.
		// The LEFT JOIN miss IS the null — `?? 0` here would invent "out of stock"
		// for a variant that has no inventory row at all.
		return rows.map((r) => ({
			productId: toProductId(r.product_id),
			variantKey: r.variant_key,
			sku: r.sku === null ? null : toSku(r.sku),
			price:
				r.price_cents === null || r.price_currency === null
					? null
					: money(cents(r.price_cents), currency(r.price_currency)),
			title: r.title,
			orphanedAt: r.orphaned_at === null ? null : new Date(r.orphaned_at),
			createdAt: new Date(r.created_at),
			updatedAt: new Date(r.updated_at),
			onHand: r.on_hand,
		}));
	}

	/**
	 * The guarded admin edit at variant grain (port doc): a conditional `UPDATE`
	 * under an optimistic compare-and-set, the atomic mirror of the fake's guard
	 * chain and of `updateCommerceFields` one level down. An edit that touches
	 * neither `sku` nor `price` is the single statement it looks like; an edit
	 * that touches either opens a transaction, because both are movements that
	 * must commit with the row — the sku's stock carry, and the currency
	 * resolution's row lock.
	 *
	 * WHY THE BEFORE-READ NEEDS NO LOCK, unlike `upsert`'s: the applying statement
	 * only matches while `updated_at` still equals `expectedUpdatedAt`, and every
	 * writer advances it, so an interleaved write turns this into `stale` rather
	 * than a carry against a sku that has since moved. Same argument as
	 * `#applyCommerceFields`, unchanged.
	 *
	 * THE PARENT LOCK IS SKIPPED FOR AN EDIT THAT CANNOT APPLY. Currency resolution
	 * locks the `product_commerce` row (see `#resolveProductCurrency`), and that
	 * lock is held to the end of the transaction — so taking it for a merchant's
	 * stale or replayed save, of which there are many, would block every other
	 * write to that product for the length of this transaction. The before-read
	 * that already feeds the rename carry therefore also decides whether the lock
	 * is worth taking. When it IS taken it is still stage one of the class lock
	 * order, ahead of the guarded UPDATE's own lock on the variant row.
	 *
	 * WHAT THE PRE-CHECK RESTS ON, stated because it is load-bearing and was not
	 * obvious. Skipping the lock also skips resolving `productCurrency`, which
	 * switches OFF guard 4b — so the pre-check must never say "cannot apply" about
	 * an edit the statement then applies. It cannot, and the reason is the store's
	 * own compare-and-set contract rather than anything local: EVERY writer of a
	 * variant row advances `updated_at` from the injected `Clock`, and the guarded
	 * UPDATE matches only while `updated_at` still equals `expectedUpdatedAt`. So a
	 * row that failed the CAS at pre-read time can pass it at statement time only
	 * if some writer moved `updated_at` BACKWARDS onto the exact value the caller
	 * quoted — i.e. only under a non-monotonic clock. THAT IS THE ASSUMPTION, named
	 * here rather than left implicit: a `Clock` that can go backwards breaks the
	 * optimistic-concurrency design of this whole port long before it reaches this
	 * optimization. The orphaned and replay branches need no clock argument at all
	 * (a resurrect advances `updated_at`, and a stored key changes only by a write
	 * that does too).
	 *
	 * It is belt-and-braces rather than an argument alone: if the statement DOES
	 * apply with a price while the resolution was skipped, `#applyVariantFields`
	 * fails loudly instead of writing a currency it never checked.
	 *
	 * WHAT A REFUSED EDIT STILL COSTS, since the pre-check does not make it free: a
	 * stale or replayed edit that CARRIES A SKU still opens a transaction and still
	 * takes up to two `inventory` row locks before the guarded UPDATE classifies it,
	 * and holds them until the transaction commits. Those locks are on the sku rows,
	 * not on the product, so they block only writers touching the same stock — but a
	 * client retrying a stale save in a tight loop is contending for real rows, not
	 * merely failing. The pre-check spares such an edit the PARENT lock, which is
	 * the one that would serialize the whole product.
	 */
	async updateVariantFields(
		input: UpdateProductVariantFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductVariantUpdateResult> {
		if (input.sku === undefined && input.price === undefined) {
			// No price in the input at all, so guard 4b has nothing to evaluate and
			// `currencyResolved` is vacuously satisfied.
			return this.#applyVariantFields(this.#db, input, key, expectedUpdatedAt, null, null, true);
		}
		return this.#db.transaction().execute(async (trx) => {
			const before = await this.#selectVariant(trx, input.productId, input.variantKey);
			const couldApply =
				before !== undefined &&
				before.orphaned_at === null &&
				before.idempotency_key !== key &&
				before.updated_at === expectedUpdatedAt;
			// Stage one of the lock order, taken for EVERY applying edit and not only
			// a priced one. Two writers under one product then never interleave at
			// all, which is what rules out every intra-product cycle — including the
			// one on `product_variants`' own partial unique index, where two crossing
			// renames each wait on the other's uncommitted index entry long before
			// either reaches an `inventory` row.
			if (couldApply) {
				await trx
					.updateTable("product_commerce")
					.set((eb) => ({ product_id: eb.ref("product_id") }))
					.where("product_id", "=", input.productId)
					.execute();
			}
			const resolveCurrency = input.price !== undefined && couldApply;
			const productCurrency = resolveCurrency
				? await this.#resolveProductCurrency(trx, input.productId, input.variantKey)
				: null;
			return this.#applyVariantFields(
				trx,
				input,
				key,
				expectedUpdatedAt,
				before?.sku ?? null,
				productCurrency,
				resolveCurrency,
			);
		});
	}

	/**
	 * The currency every money value under one product must agree on: the product
	 * row's own price currency when it has one, else any OTHER live priced
	 * variant's (a product whose sizes carry the prices has no product-level price
	 * to read). `null` ⇒ nothing to match yet, so a first pricing is free.
	 *
	 * THE PARENT READ IS A LOCKING READ — a self-assignment `UPDATE … SET
	 * product_id = product_id`, the same portable row lock `upsert`'s before-read
	 * takes (`FOR UPDATE` is not SQLite), and it touches no observable column so
	 * no other guard sees it. It is here to SERIALIZE, not to read: the compare-
	 * and-set on each variant row is per-row, so two first-pricings of two
	 * DIFFERENT variants of one product have different CAS targets and nothing
	 * else would order them — both would read "no currency yet" and both would
	 * apply, leaving one product holding two currencies. Taking the parent's lock
	 * makes one wait for the other and then see its currency.
	 *
	 * KNOWN BOUND, deliberate: a product whose `product_commerce` row does not
	 * exist yet has no row to lock (the out-of-order delivery case the port
	 * documents), so that one interleaving is unserialized. Closing it would mean
	 * minting a product row from a variant write, which is a worse trade than a
	 * window that requires a variant to be priced before its product has synced.
	 */
	async #resolveProductCurrency(
		exec: Kysely<Database>,
		productId: string,
		exceptVariantKey: string,
	): Promise<string | null> {
		const parent = await exec
			.updateTable("product_commerce")
			.set((eb) => ({ product_id: eb.ref("product_id") }))
			.where("product_id", "=", productId)
			.returning("price_currency")
			.executeTakeFirst();
		if (parent?.price_currency != null) return parent.price_currency;

		const sibling = await exec
			.selectFrom("product_variants")
			.select("price_currency")
			.where("product_id", "=", productId)
			.where("variant_key", "!=", exceptVariantKey)
			.where("orphaned_at", "is", null)
			.where("price_currency", "is not", null)
			.limit(1)
			.executeTakeFirst();
		return sibling?.price_currency ?? null;
	}

	/**
	 * `updateVariantFields`'s statement and its zero-row classifier, on whichever
	 * executor the caller opened. The classifier runs the SAME order the fake
	 * does — not_found (unknown / orphaned) FIRST, then replay, then stale, then
	 * currency_mismatch — so fake, sqlite and pg agree byte-for-byte.
	 *
	 * A product-level currency disagreement is checked in APP CODE rather than as
	 * a SQL guard (its two operands are both constants, which is a comparison no
	 * dialect should be asked to type), and it SUPPRESSES the statement entirely
	 * rather than short-circuiting the method: the classifier still runs, so a
	 * replay of a disagreeing edit still reports the replay `ok` and a stale one
	 * still reports `stale`, exactly as the guard order requires.
	 */
	async #applyVariantFields(
		exec: Kysely<Database>,
		input: UpdateProductVariantFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
		beforeSku: string | null,
		productCurrency: string | null,
		/** Whether the caller actually resolved the product currency. `false` means
		 *  guard 4b is switched off for this call — legal only when the pre-check
		 *  established the edit cannot apply, which the applying branch re-asserts. */
		currencyResolved: boolean,
	): Promise<ProductVariantUpdateResult> {
		const now = this.#clock.now().toISOString();
		const productCurrencyConflict =
			input.price !== undefined &&
			productCurrency !== null &&
			productCurrency !== input.price.currency;

		let updated: ProductVariantsTable | undefined;
		if (!productCurrencyConflict) {
			// The `inventory` pair, in SKU ORDER, BEFORE the guarded UPDATE — because
			// the UPDATE is what writes the sku, and writing it takes an entry in
			// `product_variants_live_sku_unique`. Two writers crossing skus each wait
			// on the other's uncommitted index entry there, which is a cycle no
			// later lock can undo. Serializing them on the shared `inventory` rows
			// first means only one of them is ever inside the index at a time.
			if (input.sku !== undefined) {
				const pair = beforeSku === null ? [input.sku] : [beforeSku, input.sku].toSorted();
				for (const s of pair) await this.#lockSkuRowIfPresent(exec, s);
			}
			const set: Record<string, string | number | null> = {
				idempotency_key: key,
				updated_at: now,
			};
			if (input.sku !== undefined) set.sku = input.sku;
			if (input.price !== undefined) {
				set.price_cents = input.price.amount;
				set.price_currency = input.price.currency;
			}
			// No `title` branch and no `variant_key` branch: neither field exists on
			// this input (ADR-0016; the key is the identity).
			try {
				let stmt = exec
					.updateTable("product_variants")
					.set(set)
					.where("product_id", "=", input.productId)
					.where("variant_key", "=", input.variantKey)
					// An edit is neither a create nor a resurrection — an orphaned row is
					// unreachable from this surface, exactly like a tombstoned product.
					.where("orphaned_at", "is", null)
					.where("updated_at", "=", expectedUpdatedAt)
					.where("idempotency_key", "!=", key);
				if (input.price !== undefined) {
					// Never silently switch this variant's own currency. NULL (a first
					// pricing) passes.
					const cur = input.price.currency;
					stmt = stmt.where(sql<SqlBool>`(price_currency is null or price_currency = ${cur})`);
				}
				updated = await stmt.returningAll().executeTakeFirst();
			} catch (err) {
				// Variant↔variant live-sku uniqueness is the partial index; surface it
				// as the structured domain error, never an opaque 500.
				if (input.sku !== undefined && isLiveVariantSkuUniqueViolation(err)) {
					throw new SkuConflictError(input.sku);
				}
				throw err;
			}
		}

		if (updated !== undefined) {
			// The pre-check said this edit could not apply, so guard 4b was never
			// resolved — and yet here it is applying, with a price. That is reachable
			// only if `updated_at` moved BACKWARDS onto the caller's quoted value (see
			// `updateVariantFields`'s note on the clock assumption). Fail loudly rather
			// than write a currency nothing checked; the transaction rolls back.
			if (input.price !== undefined && !currencyResolved) {
				throw new Error(
					`updateVariantFields applied a price whose product currency was never resolved for ${input.productId}/${input.variantKey}`,
				);
			}
			// A SKU NAMES ONE LIVE SELLABLE UNIT, and the other kind of unit is a
			// `product_commerce` row, which no index can cover from here. Checked
			// AFTER the guarded UPDATE matched, so the refusal keeps its place in the
			// guard order (a stale or replayed edit never reaches it) — and inside the
			// caller's transaction, so the throw rolls the write back exactly as the
			// index's would.
			const renaming = beforeSku !== null && updated.sku !== null && updated.sku !== beforeSku;
			// BEFORE THE CARRY — a PRECEDENCE decision, not a locking one. The sorted
			// pair was already acquired above, ahead of the guarded UPDATE, so this
			// check reads under the locks it needs; what is decided here is only WHICH
			// typed refusal wins when both apply, which in production-normal state is
			// most of the time (an applied assignment seeds an `inventory` row, so a
			// sku another live unit holds nearly always has one too). `SkuConflictError`
			// wins: it names the real obstacle, where `SkuStockConflictError` would
			// describe the same state as parked units and send the operator looking for
			// stock to move.
			if (input.sku !== undefined && (await this.#skuTakenByLiveProduct(exec, input.sku))) {
				throw new SkuConflictError(input.sku);
			}
			// THE SKU-RENAME RULE (port doc) — the applying branch, and only it. The
			// SAME carry the two product-level writers use: `inventory` is keyed by the
			// bare sku and knows nothing about products or variants.
			if (renaming && updated.sku !== null) {
				await this.#carrySkuStock(exec, beforeSku as string, updated.sku, key);
			}
			return { ok: true, variant: toVariantDomain(updated) };
		}

		const current = await this.#selectVariant(exec, input.productId, input.variantKey);
		if (current === undefined || current.orphaned_at !== null) {
			return { ok: false, reason: "not_found" };
		}
		if (current.idempotency_key === key) {
			return { ok: true, variant: toVariantDomain(current) }; // replay no-op.
		}
		if (current.updated_at !== expectedUpdatedAt) {
			return { ok: false, reason: "stale", current: toVariantDomain(current) };
		}
		if (
			input.price !== undefined &&
			current.price_currency !== null &&
			current.price_currency !== input.price.currency
		) {
			return { ok: false, reason: "currency_mismatch", current: toVariantDomain(current) };
		}
		if (productCurrencyConflict) {
			return { ok: false, reason: "currency_mismatch", current: toVariantDomain(current) };
		}
		// No guard explains the no-op — fail loudly rather than swallow a lost write.
		throw new Error(
			`updateVariantFields matched zero rows but no guard explains it for ${input.productId}/${input.variantKey}`,
		);
	}

	/**
	 * The ORPHAN transition (port doc): a single conditional `UPDATE`, mirroring
	 * `deactivate`'s shape one level down. Guards ANDed together:
	 *  - `idempotency_key != :key` — a SAME-KEY REPLAY is a no-op unconditionally,
	 *    the per-row compare-on-write both write paths already use. Without it a
	 *    redelivered drop could apply a second time on a row that has since been
	 *    re-declared, quietly un-selling a size the CMS currently lists.
	 *  - `orphaned_at IS NULL` — already-orphaned is a stable no-op under replay,
	 *    leaving the original tombstone instant and the watermark untouched.
	 *  - `content_updated_at IS NULL OR content_updated_at <= :t` — a delayed "the
	 *    repeater row is gone" can never orphan a variant a NEWER save has since
	 *    re-declared. NULL (never synced) is `-infinity`, so the first transition
	 *    wins. The SAME column `upsertVariant` guards on, because both transitions
	 *    ride the same save event (see the port doc for why the product's publish
	 *    gate needed a second column and this does not). `<=` here against the
	 *    resurrect's strict `>`: one save may declare some keys and drop others at
	 *    one watermark, so an orphan must apply at an equal one — while a resurrect
	 *    at an equal watermark would re-litigate a decision already taken.
	 * An unknown `(product_id, variant_key)` matches zero rows — a no-op, no row
	 * minted. The row itself is RETAINED with its sku, price and stock:
	 * deactivation, never deletion.
	 */
	async deactivateVariant(
		productId: ProductId,
		variantKey: string,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const now = this.#clock.now().toISOString();
		await this.#db
			.updateTable("product_variants")
			.set({
				orphaned_at: now,
				content_updated_at: contentUpdatedAt,
				idempotency_key: key,
				updated_at: now,
			})
			.where("product_id", "=", productId)
			.where("variant_key", "=", variantKey)
			.where("idempotency_key", "!=", key)
			.where("orphaned_at", "is", null)
			.where(
				sql<SqlBool>`(content_updated_at is null or content_updated_at <= ${contentUpdatedAt})`,
			)
			.execute();
	}

	/**
	 * A SKU NAMES ONE LIVE SELLABLE UNIT (port doc). Two halves, because no
	 * dialect indexes across two tables and each writer only needs the half its
	 * own unique index does not already cover.
	 *
	 * `#skuTakenByLiveProduct` is what a VARIANT writer asks; `#skuTakenByLiveVariant`
	 * is the reciprocal, what the two PRODUCT-level writers ask. Both are called
	 * only where the write actually applies, so a replayed, stale or
	 * watermark-rejected write refuses nothing — the exact position the partial
	 * unique index occupies on each same-table half.
	 */
	/**
	 * Take the target sku's `inventory` row lock, when it has one — the ONE row
	 * the two halves of the cross-table uniqueness rule can both contend on, since
	 * no dialect indexes across two tables and neither writer's unique index can
	 * see the other's.
	 *
	 * A self-assignment `UPDATE`, the same portable row lock `upsert`'s before-read
	 * takes (`FOR UPDATE` is not SQLite), touching no observable column. With it,
	 * a product write and a variant write reaching for one sku serialize: the
	 * second waits for the first to commit and then SEES it, so its cross-table
	 * check refuses instead of passing on a stale snapshot.
	 *
	 * THE BOUND, and it is worth stating precisely because the fix is otherwise
	 * airtight: a sku that has NEVER had an `inventory` row has nothing to lock, so
	 * two writers assigning that same never-used sku — one to a product, one to a
	 * variant, in the same instant — can still both pass. Every sku that has ever
	 * been stocked, restocked, renamed onto, or seeded by the caller's
	 * always-attempt `seedOnHand` after any earlier assignment is covered. Closing
	 * the remainder needs a row to contend on: either a sku assignment claims the
	 * `inventory` row (which would make a first sku a stock movement — the
	 * FIRST-SKU semantics deliberately say it is not), or a dedicated claim table
	 * carries a unique index spanning both kinds of unit. Both are their own
	 * decision; committed state is arbitrated correctly either way, on every
	 * adapter, and that is what the contract suite pins.
	 */
	async #lockSkuRowIfPresent(exec: Kysely<Database>, s: string): Promise<void> {
		await exec
			.updateTable("inventory")
			.set((eb) => ({ on_hand: eb.ref("on_hand") }))
			.where("sku", "=", s)
			.execute();
	}

	async #skuTakenByLiveProduct(exec: Kysely<Database>, s: string): Promise<boolean> {
		const row = await exec
			.selectFrom("product_commerce")
			.select("product_id")
			.where("sku", "=", s)
			.where("deleted_at", "is", null)
			.limit(1)
			.executeTakeFirst();
		return row !== undefined;
	}

	/** As above, from the other side. `exceptVariantKey` excludes the variant doing
	 *  the writing — re-supplying your own sku is not a conflict. */
	async #skuTakenByLiveVariant(
		exec: Kysely<Database>,
		s: string,
		exceptVariantKey?: string,
	): Promise<boolean> {
		let q = exec
			.selectFrom("product_variants")
			.select("variant_key")
			.where("sku", "=", s)
			.where("orphaned_at", "is", null);
		if (exceptVariantKey !== undefined) q = q.where("variant_key", "!=", exceptVariantKey);
		const row = await q.limit(1).executeTakeFirst();
		return row !== undefined;
	}

	/**
	 * The live-variant currencies of one product, for the reciprocal currency guard
	 * (`updateCommerceFields` clause 4c). Read under the parent row's own lock — the
	 * guarded UPDATE that lock belongs to is the very row being repriced — so a
	 * product repricing and a variant pricing cannot both pass by reading each
	 * other's "before" state. Empty for an unvarianted product, which is why the
	 * guard cannot fire on the catalog as it stands.
	 */
	async #liveVariantCurrencies(exec: Kysely<Database>, productId: string): Promise<string[]> {
		const rows = await exec
			.selectFrom("product_variants")
			.select("price_currency")
			.where("product_id", "=", productId)
			.where("orphaned_at", "is", null)
			.where("price_currency", "is not", null)
			.execute();
		return rows.flatMap((r) => (r.price_currency === null ? [] : [r.price_currency]));
	}

	/** One variant row by its composite identity. `exec` is the caller's executor
	 *  so a write that opened a transaction re-reads inside it. */
	async #selectVariant(
		exec: Kysely<Database>,
		productId: string,
		variantKey: string,
	): Promise<ProductVariantsTable | undefined> {
		return exec
			.selectFrom("product_variants")
			.selectAll()
			.where("product_id", "=", productId)
			.where("variant_key", "=", variantKey)
			.executeTakeFirst();
	}

	/** The row by its link key. `exec` defaults to the plain connection; a write
	 *  that opened a transaction passes it in, so its own re-read sees the
	 *  statement it just ran rather than the pre-transaction snapshot. */
	async #selectByProductId(
		productId: string,
		exec: Kysely<Database> = this.#db,
	): Promise<ProductCommerceTable | undefined> {
		return exec
			.selectFrom("product_commerce")
			.selectAll()
			.where("product_id", "=", productId)
			.executeTakeFirst();
	}
}

function toDomain(row: ProductCommerceTable): ProductCommerce {
	return {
		productId: toProductId(row.product_id),
		sku: row.sku === null ? null : toSku(row.sku),
		price:
			row.price_cents === null || row.price_currency === null
				? null
				: money(cents(row.price_cents), currency(row.price_currency)),
		title: row.title,
		taxClass: row.tax_class,
		compareAtPrice:
			row.compare_at_cents === null || row.compare_at_currency === null
				? null
				: money(cents(row.compare_at_cents), currency(row.compare_at_currency)),
		unitCost:
			row.unit_cost_cents === null || row.unit_cost_currency === null
				? null
				: money(cents(row.unit_cost_cents), currency(row.unit_cost_currency)),
		inventoryPolicy: row.inventory_policy as InventoryPolicy,
		weightGrams: row.weight_grams,
		lengthMm: row.length_mm,
		widthMm: row.width_mm,
		heightMm: row.height_mm,
		productKind: row.product_kind as ProductKind,
		active: row.active === 1,
		deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
		idempotencyKey: toIdempotencyKey(row.idempotency_key),
		contentUpdatedAt: row.content_updated_at,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}

/** One `product_variants` row → the domain shape. Money stays branded and
 *  NULLABLE: an absent price is absent, never zero. */
function toVariantDomain(row: ProductVariantsTable): ProductVariant {
	return {
		productId: toProductId(row.product_id),
		variantKey: row.variant_key,
		sku: row.sku === null ? null : toSku(row.sku),
		price:
			row.price_cents === null || row.price_currency === null
				? null
				: money(cents(row.price_cents), currency(row.price_currency)),
		title: row.title,
		orphanedAt: row.orphaned_at === null ? null : new Date(row.orphaned_at),
		idempotencyKey: toIdempotencyKey(row.idempotency_key),
		contentUpdatedAt: row.content_updated_at,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}

/**
 * The variant-grain twin of {@link isLiveSkuUniqueViolation}, for the
 * `product_variants_live_sku_unique` partial index — same two dialect shapes
 * (pg SQLSTATE `23505` naming the constraint; better-sqlite3's
 * `SQLITE_CONSTRAINT_UNIQUE` naming the violated columns in `table.column`
 * form), same narrow scoping, so anything else still propagates untouched.
 */
function isLiveVariantSkuUniqueViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const { code, constraint, message } = err as {
		code?: unknown;
		constraint?: unknown;
		message?: unknown;
	};
	if (code === "23505") {
		return constraint === "product_variants_live_sku_unique";
	}
	if (code === "SQLITE_CONSTRAINT_UNIQUE") {
		return (
			typeof message === "string" &&
			(message.includes("product_variants_live_sku_unique") ||
				message.includes("product_variants.sku"))
		);
	}
	return false;
}

/**
 * Narrowly-scoped unique-violation check for the
 * `product_commerce_live_sku_unique` partial index (review F2), mirroring
 * Phase 0's `isForeignKeyViolation` shape:
 *  - pg: SQLSTATE `23505` with `constraint` naming the index;
 *  - better-sqlite3: `SQLITE_CONSTRAINT_UNIQUE` whose message names the
 *    violated columns as `product_commerce.sku` (SQLite reports partial
 *    UNIQUE-index violations in table.column form, verified against
 *    better-sqlite3 12.x) — the partial index is the ONLY unique constraint
 *    over that column, so the match stays exact.
 * Anything else (other constraints, other tables) is NOT matched.
 */
function isLiveSkuUniqueViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const { code, constraint, message } = err as {
		code?: unknown;
		constraint?: unknown;
		message?: unknown;
	};
	if (code === "23505") {
		return constraint === "product_commerce_live_sku_unique";
	}
	if (code === "SQLITE_CONSTRAINT_UNIQUE") {
		return (
			typeof message === "string" &&
			(message.includes("product_commerce_live_sku_unique") ||
				message.includes("product_commerce.sku"))
		);
	}
	return false;
}

/**
 * Validates `filter.lowStockThreshold` BEFORE any query is built (port doc —
 * `InvalidLowStockThresholdError`), via the SAME `isValidLowStockThreshold`
 * guard the fake calls, so the two dialects sharing this class and the
 * IO-free fake can never drift on out-of-domain input. Called at the top of
 * BOTH `listProducts` and `countProducts` — never left to the driver: a raw
 * out-of-domain value reaching Postgres fails binding an `integer` column
 * ("invalid input syntax for type integer"), while better-sqlite3 accepts it
 * and answers a DIFFERENT (wrong) row set, which is the exact three-way
 * disagreement this guard exists to make unreachable.
 */
function assertValidLowStockThreshold(filter: ProductListFilter): void {
	if (
		filter.lowStockThreshold !== undefined &&
		!isValidLowStockThreshold(filter.lowStockThreshold)
	) {
		throw new InvalidLowStockThresholdError(filter.lowStockThreshold);
	}
}

/**
 * The ONE `ProductListFilter` predicate `listProducts` builds from (mirrors
 * `orderFilterConditions` — a single builder so semantics can never drift).
 * Returns standalone expressions (a detached `expressionBuilder`) to AND onto
 * the query. `search` matches EITHER an exact-lower sku OR a case-insensitive
 * substring of `title` (port doc — deliberately diverges from `OrderListFilter
 * .search`'s exact-only semantics); a NULL `sku`/`title` simply fails its half
 * of the OR (SQL `NULL LIKE …` / `NULL = …` is unknown ⇒ false), never a throw.
 * `deleted` is DELIBERATELY absent from this builder — it flips the base
 * query's `deleted_at IS [NOT] NULL` clause in `listProducts` directly, not an
 * ANDed condition here (the two are mutually exclusive branches, not a
 * composable filter half). `lowStockThreshold` (port doc) reads
 * `inventory.on_hand` — present in `listProducts`'s unconditional LEFT JOIN,
 * and in `countProducts`'s CONDITIONAL one — so this builder is safe to share
 * between both callers regardless of which one actually joined the table.
 */
function productFilterConditions(filter: ProductListFilter): Expression<SqlBool>[] {
	const eb: ExpressionBuilder<Database, "product_commerce"> = expressionBuilder();
	const conds: Expression<SqlBool>[] = [];
	if (filter.active !== undefined) {
		conds.push(eb("product_commerce.active", "=", filter.active ? 1 : 0));
	}
	if (filter.productKind !== undefined) {
		conds.push(eb("product_commerce.product_kind", "=", filter.productKind));
	}
	if (filter.search !== undefined) {
		const search = filter.search;
		const likePattern = `%${escapeLikePattern(search)}%`;
		conds.push(
			eb.or([
				eb(sql`lower(product_commerce.sku)`, "=", search.toLowerCase()),
				sql<SqlBool>`lower(product_commerce.title) like lower(${likePattern}) escape '\\'`,
			]),
		);
	}
	if (filter.lowStockThreshold !== undefined) {
		// `inventory` isn't in this builder's typed FROM set (it's only ever
		// LEFT JOINed onto the caller's query, not this detached
		// `expressionBuilder`), so this is raw SQL rather than a typed `eb(...)`
		// ref — same escape hatch the title half of `search` already uses.
		// `on_hand IS NOT NULL` is load-bearing: a LEFT JOIN miss must fail this
		// predicate (unknown stock is never "low"), never compare NULL <= n
		// (which SQL evaluates to unknown/false anyway, but the explicit guard
		// documents the intent rather than relying on that quirk).
		conds.push(
			sql<SqlBool>`(inventory.on_hand is not null and inventory.on_hand <= ${filter.lowStockThreshold})`,
		);
	}
	return conds;
}

/** Escape a raw user string for safe embedding in a SQL `LIKE` pattern —
 *  `\`, `%`, and `_` are LIKE metacharacters (the escape char first, so it
 *  never double-escapes itself). Portable across pg and better-sqlite3, both
 *  of which support `LIKE … ESCAPE '\'`. A search for a literal `%`/`_` (e.g.
 *  a title like "50% off") must match literally, never as a wildcard. */
function escapeLikePattern(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
