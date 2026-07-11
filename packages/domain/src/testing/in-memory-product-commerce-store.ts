import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceView,
	UpsertProductCommerceInput,
} from "../ports/product-commerce-store.js";
import { MissingProductIdError, SkuConflictError } from "../product-commerce/errors.js";

export interface InMemoryProductCommerceStoreOptions {
	clock: Clock;
	/**
	 * Phase 2 (`listCommerceByIds`): the fake's stand-in for the real store's
	 * intra-service `inventory` join — a plain lookup the harness seeds
	 * (`InMemoryInventoryStore.onHand` satisfies it structurally). Defaults
	 * to "no inventory row" (0) so `inStock` is coarsely false, mirroring a
	 * LEFT JOIN miss.
	 */
	inventoryOnHand?: (sku: string) => number;
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
 * A sync upsert whose `contentUpdatedAt` is strictly older than the stored
 * watermark is a stale no-op (out-of-order hook delivery converges); the
 * publish gate (`activate`/`deactivate`) converges the same way under its own
 * separate gate watermark (see `#activeWatermark`). A LIVE
 * row's sku is unique across live rows only (mirrors the store's
 * `UNIQUE (sku) WHERE deleted_at IS NULL` partial index): assigning a sku
 * held by another non-deleted row throws; a sku freed by a soft delete is
 * reusable.
 */
export class InMemoryProductCommerceStore implements ProductCommerceStore {
	#clock: Clock;
	#rows = new Map<string, ProductCommerce>();
	/**
	 * The publish-gate ordering watermark (the last `contentUpdatedAt` a
	 * winning `activate`/`deactivate` applied), kept in a DEDICATED map rather
	 * than reusing the row's `contentUpdatedAt` (the sync/upsert watermark): a
	 * plain `content:afterSave` advances that one WITHOUT being a lifecycle
	 * event, so sharing it would let a save poison the gate and let a stale
	 * lifecycle POST win. Mirrors the store's separate `active_updated_at`
	 * column. Absent (never transitioned) is treated as `-infinity`, so the
	 * first transition always wins.
	 */
	#activeWatermark = new Map<string, string>();
	#inventoryOnHand: (sku: string) => number;

	constructor(options: InMemoryProductCommerceStoreOptions) {
		this.#clock = options.clock;
		this.#inventoryOnHand = options.inventoryOnHand ?? (() => 0);
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
			if (
				input.contentUpdatedAt !== undefined &&
				existing.contentUpdatedAt !== null &&
				input.contentUpdatedAt < existing.contentUpdatedAt
			) {
				// Stale sync (strictly older content revision than the stored
				// watermark): a delayed/re-ordered hook delivery never overwrites
				// fresher data.
				return existing;
			}
			// After the no-op guards, mirroring the store: a skipped DO UPDATE
			// never contends for the sku index.
			this.#assertLiveSkuFree(input);
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
				contentUpdatedAt:
					input.contentUpdatedAt !== undefined ? input.contentUpdatedAt : existing.contentUpdatedAt,
				updatedAt: now,
			};
			this.#rows.set(input.productId, updated);
			return updated;
		}

		this.#assertLiveSkuFree(input);
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
			contentUpdatedAt: input.contentUpdatedAt ?? null,
			createdAt: now,
			updatedAt: now,
		};
		this.#rows.set(input.productId, created);
		return created;
	}

	/** Mirrors the store's `UNIQUE (sku) WHERE deleted_at IS NULL` partial
	 *  index: only LIVE rows contend for a sku. Throws the structured domain
	 *  `SkuConflictError` (review F2), exactly like the Kysely store's
	 *  narrowly-scoped constraint-violation catch. */
	#assertLiveSkuFree(input: UpsertProductCommerceInput): void {
		if (input.sku === undefined) return;
		for (const row of this.#rows.values()) {
			if (row.productId !== input.productId && row.sku === input.sku && row.deletedAt === null) {
				throw new SkuConflictError(input.sku);
			}
		}
	}

	async getByProductId(productId: ProductId): Promise<ProductCommerce | null> {
		return this.#rows.get(productId) ?? null;
	}

	/**
	 * Batch catalog read (Phase 2 §6) — mirrors the Kysely store's single
	 * `product_commerce LEFT JOIN inventory` statement: only commerce-complete
	 * live rows become views; `inStock` is the coarse `on_hand > 0`; missing
	 * ids are omitted; duplicates collapse. Inactive rows are RETURNED with
	 * `active: false` — the purchasability gate is the plugin's `joinProduct`
	 * (`purchasable ⟺ commerce !== null && commerce.active`), not the store
	 * (see the port doc).
	 */
	async listCommerceByIds(productIds: ProductId[]): Promise<ProductCommerceView[]> {
		const views: ProductCommerceView[] = [];
		const seen = new Set<string>();
		for (const id of productIds) {
			if (seen.has(id)) continue;
			seen.add(id);
			const row = this.#rows.get(id);
			if (row === undefined || row.deletedAt !== null) continue;
			if (row.sku === null || row.price === null) continue;
			views.push({
				productId: row.productId,
				sku: row.sku,
				price: row.price,
				inStock: this.#inventoryOnHand(row.sku) > 0,
				active: row.active,
			});
		}
		return views;
	}

	// -- writes ---------------------------------------------------------------

	/** The afterPublish→activate follow-up (port doc): unknown/soft-deleted/
	 *  already-active rows are stable no-ops; a soft-deleted product is never
	 *  resurrected by a publish; a stale `contentUpdatedAt` (strictly older
	 *  than the gate watermark a newer lifecycle event applied) is a no-op so
	 *  out-of-order publish/unpublish delivery converges. A winning flip
	 *  advances the gate watermark. */
	async activate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const existing = this.#rows.get(productId);
		if (existing === undefined) return; // unknown product_id: nothing to activate.
		if (existing.deletedAt !== null) return; // soft-deleted: must not resurrect.
		if (existing.active) return; // already active: stable no-op under replay.
		if (this.#staleGate(productId, contentUpdatedAt)) return; // stale out-of-order publish.
		this.#rows.set(productId, {
			...existing,
			active: true,
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		});
		this.#activeWatermark.set(productId, contentUpdatedAt);
	}

	/** The afterUnpublish→deactivate follow-up (port doc): the mirror of
	 *  `activate`. Unknown/soft-deleted/already-inactive rows are stable
	 *  no-ops; the tombstone is never touched (deactivation is not a soft
	 *  delete, and a deleted row is never resurrected or re-stamped); a stale
	 *  `contentUpdatedAt` is a no-op so out-of-order delivery converges. A
	 *  winning flip advances the gate watermark. */
	async deactivate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const existing = this.#rows.get(productId);
		if (existing === undefined) return; // unknown product_id: nothing to deactivate.
		if (existing.deletedAt !== null) return; // soft-deleted: leave the tombstone alone.
		if (!existing.active) return; // already inactive: stable no-op under replay.
		if (this.#staleGate(productId, contentUpdatedAt)) return; // stale out-of-order unpublish.
		this.#rows.set(productId, {
			...existing,
			active: false,
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		});
		this.#activeWatermark.set(productId, contentUpdatedAt);
	}

	/** A lifecycle POST is stale iff the gate watermark a newer transition
	 *  already applied is STRICTLY NEWER than this one (mirrors the store's
	 *  `active_updated_at <= :t` guard; ISO-8601 lexicographic = chronological).
	 *  Absent watermark (never transitioned) ⇒ never stale — first flip wins. */
	#staleGate(productId: string, contentUpdatedAt: string): boolean {
		const applied = this.#activeWatermark.get(productId);
		return applied !== undefined && applied > contentUpdatedAt;
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
