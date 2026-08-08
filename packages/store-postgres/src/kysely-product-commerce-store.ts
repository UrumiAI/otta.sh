import {
	cents,
	currency,
	idempotencyKey as toIdempotencyKey,
	InvalidLowStockThresholdError,
	isValidLowStockThreshold,
	MissingProductIdError,
	money,
	productId as toProductId,
	sku as toSku,
	SkuConflictError,
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
	type UpdateProductCommerceFieldsInput,
	type UpsertProductCommerceInput,
} from "@otta-sh/domain";
import {
	type Expression,
	expressionBuilder,
	type ExpressionBuilder,
	type Kysely,
	sql,
	type SqlBool,
} from "kysely";
import type { Database, ProductCommerceTable } from "./schema.js";

export interface KyselyProductCommerceStoreOptions {
	db: Kysely<Database>;
	clock: Clock;
}

/**
 * `ProductCommerceStore` over Kysely (Phase 1 step 4), dialect-agnostic
 * across better-sqlite3 and pg.
 *
 * `upsert` is ONE conditional statement (adapter-architecture §2): an
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
 * with one follow-up `SELECT` — this is not an oversell-style race target
 * (plan §7: no new concurrency test here), so the extra read does not
 * compromise any invariant.
 *
 * Live-sku uniqueness is the migration's partial unique index
 * (`UNIQUE (sku) WHERE deleted_at IS NULL`, review S3) — the `ON CONFLICT`
 * target stays the `product_id` PK, so the partial index never arbitrates
 * the upsert; a genuinely conflicting live sku surfaces as a constraint
 * error on both dialects, and a soft-deleted row's sku is reusable.
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
			// The row's sku BEFORE the write, read inside the transaction: it is
			// half of THE SKU-RENAME RULE's input, and the carry below must commit
			// or roll back with the row it belongs to.
			const before = await trx
				.selectFrom("product_commerce")
				.select("sku")
				.where("product_id", "=", input.productId)
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
		// THE SKU-RENAME RULE (port doc), against the row's before/after values —
		// so a same-key replay and a stale-watermark no-op, which both re-read and
		// return the STORED row, compare equal here and move nothing.
		if (beforeSku !== null && resolved.sku !== null && resolved.sku !== beforeSku) {
			await this.#carrySkuStock(exec, beforeSku, resolved.sku);
		}
		return toDomain(resolved);
	}

	/**
	 * THE SKU-RENAME RULE's inventory half (port doc on `ProductCommerceStore`),
	 * on the SAME executor as the product-row write so the rename and the stock
	 * movement commit or roll back together. Three statements, portable across
	 * both dialects:
	 *
	 *  1. CLAIM the target — `INSERT … ON CONFLICT (sku) DO NOTHING RETURNING`.
	 *     The insert IS the occupancy test, which is what makes it safe under
	 *     concurrency: two renames onto one free target cannot both see it free,
	 *     because the second conflicts with the first's uncommitted row. Zero
	 *     rows back ⇒ the sku already has an inventory row ⇒ refuse the whole
	 *     write. The test never looks at what the row HOLDS, so a row at 0
	 *     refuses exactly like a stocked one.
	 *  2. LOCK AND READ the source — a self-assignment `UPDATE … SET on_hand =
	 *     on_hand … RETURNING on_hand`. Reading through an UPDATE rather than a
	 *     SELECT takes the row's write lock for the rest of the transaction
	 *     (portably — `FOR UPDATE` is not SQLite), so the count read here cannot
	 *     move under a concurrent reserve/restock/removal between this statement
	 *     and the zeroing below, which is exactly how units would go missing.
	 *     No row ⇒ nothing to carry; the claimed target simply stays at 0.
	 *  3. MOVE — the count onto the target, then zero the source. The source row
	 *     is RETAINED: `reservations.sku` references `inventory.sku`, so a sku
	 *     that has ever been reserved can be neither deleted nor re-keyed, and a
	 *     stock row is never deleted regardless.
	 */
	async #carrySkuStock(exec: Kysely<Database>, fromSku: string, toSku: string): Promise<void> {
		if (fromSku === toSku) return;

		const claimed = await exec
			.insertInto("inventory")
			.values({ sku: toSku, on_hand: 0 })
			.onConflict((oc) => oc.column("sku").doNothing())
			.returning("sku")
			.executeTakeFirst();
		if (claimed === undefined) throw new SkuStockConflictError(fromSku, toSku);

		const source = await exec
			.updateTable("inventory")
			.set((eb) => ({ on_hand: eb.ref("on_hand") }))
			.where("sku", "=", fromSku)
			.returning("on_hand")
			.executeTakeFirst();
		if (source === undefined || source.on_hand === 0) return;

		await exec
			.updateTable("inventory")
			.set({ on_hand: source.on_hand })
			.where("sku", "=", toSku)
			.execute();
		await exec.updateTable("inventory").set({ on_hand: 0 }).where("sku", "=", fromSku).execute();
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
	 * Guarded admin edit (port doc): a single conditional `UPDATE` under an
	 * optimistic compare-and-set — the atomic mirror of the fake's guard chain.
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
	 * mirroring `upsert`'s no-op-then-reread pattern (not an oversell race
	 * target: the mutation itself is one atomic statement; a lost concurrent edit
	 * surfaces deterministically as `stale`, never a torn write). Live-sku
	 * collisions surface as `SkuConflictError`, exactly like `upsert`.
	 */
	async updateCommerceFields(
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductCommerceUpdateResult> {
		// As in `upsert`: no sku in play ⇒ no rename ⇒ the edit stays the single
		// statement it has always been, on the plain connection.
		if (input.sku === undefined) {
			return this.#applyCommerceFields(this.#db, input, key, expectedUpdatedAt, null);
		}
		return this.#db.transaction().execute(async (trx) => {
			const before = await trx
				.selectFrom("product_commerce")
				.select("sku")
				.where("product_id", "=", input.productId)
				.executeTakeFirst();
			return this.#applyCommerceFields(trx, input, key, expectedUpdatedAt, before?.sku ?? null);
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
	): Promise<ProductCommerceUpdateResult> {
		const now = this.#clock.now().toISOString();
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

		if (updated !== undefined) {
			// THE SKU-RENAME RULE (port doc) — the applying branch, and only it.
			if (beforeSku !== null && updated.sku !== null && updated.sku !== beforeSku) {
				await this.#carrySkuStock(exec, beforeSku, updated.sku);
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
