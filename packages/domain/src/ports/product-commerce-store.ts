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
 * The read model one catalog price/availability slot needs (Phase 2 §6) —
 * deliberately narrower than `ProductCommerce`: only "commerce-complete"
 * rows (live, sku set, price set) ever become a view, so every field here is
 * non-null and the plugin's join never re-derives "is this sellable" from
 * nullable parts. Money stays branded (`Cents` + `Currency`) end-to-end.
 */
export interface ProductCommerceView {
	productId: ProductId;
	sku: Sku;
	price: Money;
	/**
	 * Coarse display-only stock signal: `inventory.on_hand > 0` at read time
	 * (Phase 2 §8 risk 5, pre-approved). NOT reservation-aware — it can say
	 * "in stock" moments before a concurrent buyer takes the last unit.
	 * Display/JSON-LD convenience only; Phase 3's `reserve` is the authority
	 * on whether a purchase actually succeeds.
	 */
	inStock: boolean;
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
	/**
	 * Batch catalog read (Phase 2 §6) — a query, not a command: mutates
	 * nothing, carries no idempotency key. Returns a `ProductCommerceView`
	 * for every id with a commerce-complete row (live, sku + price set), in
	 * no guaranteed order; duplicates in the input collapse to one record.
	 *
	 * Missing ids are silently OMITTED, never an error — unknown id,
	 * soft-deleted row, and "create, then price" not finished all look the
	 * same to the caller (absence ⇒ `commerce: null` ⇒ `purchasable: false`
	 * at the plugin's join; "no status-code-as-logic").
	 *
	 * `active` is deliberately NOT a gate here: `content:afterPublish` is
	 * deferred (Phase 1 §6 step 7), so nothing sets `active=true` yet and
	 * every synced row is `active=false` — gating on it would render the
	 * entire catalog non-purchasable. Revisit when publish-gating lands.
	 *
	 * INVARIANT — protect from refactoring (Phase 2 §6, do not weaken
	 * without updating the plan): `inStock` MUST be computed inside the
	 * store, joining `product_commerce` + `inventory` in ONE statement (an
	 * intra-service-DB join — both tables live in the commerce DB; the
	 * "no cross-DB joins" rule is about CMS-DB↔commerce-DB). It must never
	 * split into a second client-visible round trip (e.g. a separate
	 * inventory-by-ids call from the plugin) — that would reintroduce the
	 * N+1/extra-round-trip problem the batch shape exists to prevent. Pinned
	 * by a store-level query-count test and the PLP-level "zero
	 * inventory-only HTTP calls" test, not just this comment.
	 */
	listCommerceByIds(productIds: ProductId[]): Promise<ProductCommerceView[]>;
}
