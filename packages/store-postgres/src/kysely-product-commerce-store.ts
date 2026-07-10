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
import type { Kysely } from "kysely";
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
 * `INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE idempotency_key !=
 * :key` (per-row compare-on-write dedupe, plan §4 — deliberately NOT a
 * global unique constraint). Fields omitted from the input (`undefined`)
 * resolve to the EXISTING column via the `product_commerce.<col>` reference
 * in the SET list rather than `excluded.<col>`, so a partial upsert never
 * clobbers fields it didn't touch. When the WHERE guard makes the statement
 * a no-op (replay with the same stored key), `RETURNING` yields no row, and
 * the current row is re-read with one follow-up `SELECT` — this is not an
 * oversell-style race target (plan §7: no new concurrency test here), so
 * the extra read does not compromise any invariant.
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
						updated_at: eb.ref("excluded.updated_at"),
					}))
					.where("product_commerce.idempotency_key", "!=", key),
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
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}
