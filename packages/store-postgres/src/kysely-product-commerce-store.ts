import {
	cents,
	currency,
	idempotencyKey as toIdempotencyKey,
	MissingProductIdError,
	money,
	productId as toProductId,
	sku as toSku,
	type Clock,
	type IdempotencyKey,
	type ProductCommerce,
	type ProductCommerceStore,
	type ProductId,
	type ProductKind,
	type UpsertProductCommerceInput,
} from "@urumi/domain";
import { type Kysely, sql, type SqlBool } from "kysely";
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
		const hasTaxClass = input.taxClass !== undefined;
		const hasWeightGrams = input.weightGrams !== undefined;
		const hasLengthMm = input.lengthMm !== undefined;
		const hasWidthMm = input.widthMm !== undefined;
		const hasHeightMm = input.heightMm !== undefined;
		const hasProductKind = input.productKind !== undefined;
		const hasContentUpdatedAt = input.contentUpdatedAt !== undefined;

		const row = await this.#db
			.insertInto("product_commerce")
			.values({
				product_id: input.productId,
				sku: input.sku ?? null,
				price_cents: input.price?.amount ?? null,
				price_currency: input.price?.currency ?? null,
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

	async softDelete(productId: ProductId, key: IdempotencyKey): Promise<void> {
		const now = this.#clock.now().toISOString();
		await this.#db
			.updateTable("product_commerce")
			.set({ active: 0, deleted_at: now, idempotency_key: key, updated_at: now })
			.where("product_id", "=", productId)
			.where("deleted_at", "is", null)
			.execute();
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
