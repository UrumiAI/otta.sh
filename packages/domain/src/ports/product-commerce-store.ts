import type { Money } from "../money/cents.js";
import type { IdempotencyKey, ProductId, Sku } from "../money/ids.js";

/** v1 scope — no variations (Phase 1 §2/§4). */
export type ProductKind = "physical" | "digital";

/**
 * Branded upsert input (Phase 1 §7). `productId` is the CMS content id (the
 * link key, Phase 1 §4) and is required. Every other commercial field is
 * OPTIONAL for two reasons:
 *  - `content:afterSave` fires a sync upsert on every save of a `products`
 *    document, including before any commercial data has ever been entered
 *    ("create then price", §1 case 3) — that call ensures a row exists keyed
 *    by `product_id` without asserting sku/price.
 *  - Once set, `undefined` on a later upsert PRESERVES the stored value
 *    (partial-update-like upsert); an explicit `null` clears a nullable
 *    field. `sku`/`price` cannot be cleared back to null once set (there is
 *    no "unpriced again" case in scope).
 *
 * A raw `number` price is a compile error — `price.amount` is branded `Cents`
 * (DEVELOPMENT.md §4); see `product-commerce.type-test.ts`.
 */
export interface UpsertProductCommerceInput {
	productId: ProductId;
	sku?: Sku;
	price?: Money;
	taxClass?: string | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: ProductKind;
	/**
	 * Ordering guard for CONTENT-SYNC upserts (plan §4 "out-of-order delivery
	 * converges"): the CMS content's own `updatedAt` — an opaque ISO-8601
	 * string, so lexicographic comparison IS chronological comparison —
	 * carried by `content:afterSave`. When both the incoming input and the
	 * stored row carry one, an upsert with a STRICTLY OLDER value is a stale
	 * no-op returning the existing row: a delayed/re-ordered hook delivery can
	 * never overwrite fresher data. Panel saves omit it (explicit merchant
	 * intent is last-writer-wins — the documented, accepted lost-update
	 * semantics for concurrent panel edits) and preserve the stored value.
	 */
	contentUpdatedAt?: string;
}

/** The stored row (Phase 1 §4 schema), as read back from a store. */
export interface ProductCommerce {
	productId: ProductId;
	sku: Sku | null;
	price: Money | null;
	taxClass: string | null;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: ProductKind;
	/** `afterPublish` (deferred, §6 step 7) flips true; unpublished/new = false. */
	active: boolean;
	/** Soft-delete tombstone (§4) — the row is retained, never hard-deleted. */
	deletedAt: Date | null;
	/** Per-row "last applied" replay key — compare-on-write, NOT a global
	 *  UNIQUE constraint (§4 — distinct from Phase 0's `reservations`). */
	idempotencyKey: IdempotencyKey;
	/** Last CMS `content.updatedAt` applied by a sync upsert (the staleness
	 *  watermark); null until a sync has ever carried one. */
	contentUpdatedAt: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Intent, not SQL (Phase 1 §7): insert-or-update by `product_id`, idempotent
 * under `key` (a replay whose incoming key equals the stored key is a no-op
 * returning the existing row unchanged; a new key applies and overwrites the
 * stored key), and order-aware under `contentUpdatedAt` (a strictly older
 * sync is a stale no-op — see the input doc). Reject a missing/empty
 * `product_id` with `MissingProductIdError` before any row is minted.
 * A live (non-deleted) row's `sku` is unique across live rows only — a SKU
 * freed by a soft delete is reusable by a new product (review S3; enforced
 * by a partial unique index in the store, mirrored by the fake).
 * `getByProductId` (not `get`) so the identity it reads by is unambiguous at
 * every call site.
 */
export interface ProductCommerceStore {
	upsert(input: UpsertProductCommerceInput, key: IdempotencyKey): Promise<ProductCommerce>;
	getByProductId(productId: ProductId): Promise<ProductCommerce | null>;
	/** Soft delete: sets `deletedAt` + `active=false`; retains the row. A
	 *  replay with the same key (or an already-deleted / unknown row) is a
	 *  no-op. */
	softDelete(productId: ProductId, key: IdempotencyKey): Promise<void>;
}
