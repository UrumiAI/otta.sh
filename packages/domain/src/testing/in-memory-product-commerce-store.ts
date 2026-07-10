import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	UpsertProductCommerceInput,
} from "../ports/product-commerce-store.js";
import { MissingProductIdError } from "../product-commerce/errors.js";

export interface InMemoryProductCommerceStoreOptions {
	clock: Clock;
}

/**
 * The IO-free `ProductCommerceStore` fake (Phase 1 step 2) — the first
 * adapter the contract suite runs against, mirroring `InMemoryInventoryStore`
 * (Phase 0 §0.2c).
 *
 * Upsert semantics: undefined fields on a later upsert PRESERVE the stored
 * value; `null` clears a nullable field. A replay whose incoming key equals
 * the stored `idempotencyKey` is a no-op returning the existing row
 * unchanged; any other key applies the update and overwrites the stored key
 * (per-row compare-on-write — Phase 1 §4, NOT a global unique constraint).
 */
export class InMemoryProductCommerceStore implements ProductCommerceStore {
	#clock: Clock;
	#rows = new Map<string, ProductCommerce>();

	constructor(options: InMemoryProductCommerceStoreOptions) {
		this.#clock = options.clock;
	}

	async upsert(input: UpsertProductCommerceInput, key: IdempotencyKey): Promise<ProductCommerce> {
		if (typeof input.productId !== "string" || input.productId.length === 0) {
			throw new MissingProductIdError();
		}

		const now = this.#clock.now();
		const existing = this.#rows.get(input.productId);

		if (existing !== undefined) {
			if (existing.idempotencyKey === key) {
				// Replay with the same stored key: a provable no-op.
				return existing;
			}
			const updated: ProductCommerce = {
				...existing,
				sku: input.sku !== undefined ? input.sku : existing.sku,
				price: input.price !== undefined ? input.price : existing.price,
				taxClass: input.taxClass !== undefined ? input.taxClass : existing.taxClass,
				weightGrams: input.weightGrams !== undefined ? input.weightGrams : existing.weightGrams,
				lengthMm: input.lengthMm !== undefined ? input.lengthMm : existing.lengthMm,
				widthMm: input.widthMm !== undefined ? input.widthMm : existing.widthMm,
				heightMm: input.heightMm !== undefined ? input.heightMm : existing.heightMm,
				productKind: input.productKind ?? existing.productKind,
				idempotencyKey: key,
				updatedAt: now,
			};
			this.#rows.set(input.productId, updated);
			return updated;
		}

		const created: ProductCommerce = {
			productId: input.productId,
			sku: input.sku ?? null,
			price: input.price ?? null,
			taxClass: input.taxClass ?? null,
			weightGrams: input.weightGrams ?? null,
			lengthMm: input.lengthMm ?? null,
			widthMm: input.widthMm ?? null,
			heightMm: input.heightMm ?? null,
			productKind: input.productKind ?? "physical",
			active: false,
			deletedAt: null,
			idempotencyKey: key,
			createdAt: now,
			updatedAt: now,
		};
		this.#rows.set(input.productId, created);
		return created;
	}

	async getByProductId(productId: ProductId): Promise<ProductCommerce | null> {
		return this.#rows.get(productId) ?? null;
	}

	async softDelete(productId: ProductId, key: IdempotencyKey): Promise<void> {
		const existing = this.#rows.get(productId);
		if (existing === undefined) return; // unknown product_id: no-op.
		if (existing.deletedAt !== null) return; // already deleted: stable no-op.
		this.#rows.set(productId, {
			...existing,
			active: false,
			deletedAt: this.#clock.now(),
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		});
	}
}
