import {
	cents,
	currency,
	idempotencyKey as toIdempotencyKey,
	MissingProductIdError,
	money,
	productId as toProductId,
	sku as toSku,
	SkuConflictError,
	type Clock,
	type IdempotencyKey,
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
} from "@urumi/domain";
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
			row = await this.#db
				.insertInto("product_commerce")
				.values({
					product_id: input.productId,
					sku: input.sku ?? null,
					price_cents: input.price?.amount ?? null,
					price_currency: input.price?.currency ?? null,
					title: input.title ?? null,
					tax_class: input.taxClass ?? null,
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

		const resolved = row ?? (await this.#selectByProductId(input.productId));
		if (resolved === undefined) {
			throw new Error(`product_commerce upsert lost its row for product_id ${input.productId}`);
		}
		return toDomain(resolved);
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
	 * the SAME order the fake does — replay (stored key == key) → not_found
	 * (missing / soft-deleted) → stale (updatedAt moved) → currency_mismatch —
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
		if (input.title !== undefined) set.title = input.title;
		if (input.taxClass !== undefined) set.tax_class = input.taxClass;
		if (input.weightGrams !== undefined) set.weight_grams = input.weightGrams;
		if (input.lengthMm !== undefined) set.length_mm = input.lengthMm;
		if (input.widthMm !== undefined) set.width_mm = input.widthMm;
		if (input.heightMm !== undefined) set.height_mm = input.heightMm;
		if (input.productKind !== undefined) set.product_kind = input.productKind;

		let updated: ProductCommerceTable | undefined;
		try {
			let stmt = this.#db
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
			}
			updated = await stmt.returningAll().executeTakeFirst();
		} catch (err) {
			if (input.sku !== undefined && isLiveSkuUniqueViolation(err)) {
				throw new SkuConflictError(input.sku);
			}
			throw err;
		}

		if (updated !== undefined) return { ok: true, product: toDomain(updated) };

		// Zero rows applied — classify the no-op from a fresh read, in the fake's
		// guard order so fake/sqlite/pg agree byte-for-byte.
		const current = await this.#selectByProductId(input.productId);
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
	 * Admin Products console list (view-only; port doc): a SINGLE SELECT over
	 * `product_commerce` alone — no `inventory` join, so the list never N+1s
	 * into stock per row (the detail leaf's single-sku `InventoryStore.
	 * getOnHand` read covers that). Keyset pagination on `(created_at DESC,
	 * product_id DESC)`, byte-for-byte mirroring `listOrders`: fetch `limit + 1`
	 * to detect a next page, emit `nextCursor` from the last RETURNED row.
	 * `created_at` is fixed-width ISO-8601 text ⇒ lexical order IS chronological,
	 * so the raw text comparisons below are dialect-identical (no casts) across
	 * better-sqlite3 and pg. Always excludes soft-deleted rows (port doc).
	 */
	async listProducts(filter: ProductListFilter, page: ProductListPage): Promise<ProductListResult> {
		let q = this.#db
			.selectFrom("product_commerce")
			.select([
				"product_commerce.product_id as product_id",
				"product_commerce.sku as sku",
				"product_commerce.title as title",
				"product_commerce.price_cents as price_cents",
				"product_commerce.price_currency as price_currency",
				"product_commerce.product_kind as product_kind",
				"product_commerce.active as active",
				"product_commerce.created_at as created_at",
			])
			.where("product_commerce.deleted_at", "is", null);

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
			createdAt: r.created_at,
		}));
		return { products, nextCursor };
	}

	async #selectByProductId(productId: string): Promise<ProductCommerceTable | undefined> {
		return this.#db
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
 * The ONE `ProductListFilter` predicate `listProducts` builds from (mirrors
 * `orderFilterConditions` — a single builder so semantics can never drift).
 * Returns standalone expressions (a detached `expressionBuilder`) to AND onto
 * the query. `search` matches EITHER an exact-lower sku OR a case-insensitive
 * substring of `title` (port doc — deliberately diverges from `OrderListFilter
 * .search`'s exact-only semantics); a NULL `sku`/`title` simply fails its half
 * of the OR (SQL `NULL LIKE …` / `NULL = …` is unknown ⇒ false), never a throw.
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
