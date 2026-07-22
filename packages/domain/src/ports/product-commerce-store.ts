import type { Money } from "../money/cents.js";
import type { IdempotencyKey, ProductId, Sku } from "../money/ids.js";

// -- Admin product console: view-only list (keyset pagination) --------------
// Admin-UX Increment 2, "product enumerate + product list" — the missing
// atomic primitive this slice adds, mirroring `OrderStore.listOrders`'s
// grain and proven keyset shape.

/**
 * Filters for the admin Products list. All optional — an empty filter lists
 * every LIVE (non-soft-deleted) product. Deliberately narrower-cardinality
 * than `OrderListFilter.states` (an OR-set): a product's `active` publish
 * gate and `productKind` are each a two-value axis, so a single-value
 * equality filter is the honest, minimal mirror rather than an over-general
 * array.
 *
 * `search` DELIBERATELY DIVERGES from `OrderListFilter.search`'s exact-only
 * semantics: an order's `id`/`buyer_ref` are identifiers a merchant looks up
 * exactly, but a product `title` is free text a merchant partially
 * remembers, so title matches as a case-insensitive SUBSTRING; `sku` — a
 * structured identifier, like an order's `buyer_ref` — stays an exact,
 * case-insensitive match. A row matches if EITHER half matches (never both
 * required).
 */
export interface ProductListFilter {
	/** Equality filter on the publish-gate flag; omitted ⇒ both active and
	 *  inactive rows list. */
	active?: boolean;
	/** Equality filter on the v1 product kind; omitted ⇒ both kinds list. */
	productKind?: ProductKind;
	/** Case-insensitive: a SUBSTRING match on `title` OR an EXACT match on
	 *  `sku` (see the filter doc for why the two axes diverge). A row with a
	 *  null `title`/`sku` simply cannot match that half — never a throw. */
	search?: string;
	/**
	 * The tombstone axis (admin-UX Increment 2, "product lifecycle surfacing"
	 * — the archive-view follow-up to the always-excludes-deleted default).
	 * Deliberately NOT an OR-able array like `OrderListFilter.states`: a row is
	 * either live or soft-deleted, a strict two-value axis, so a single
	 * equality filter is the honest, minimal mirror of `active`.
	 *  - omitted or `false` ⇒ the ORIGINAL default: only LIVE rows list
	 *    (`deleted_at IS NULL`) — unchanged behavior, so every existing caller
	 *    that never set this field keeps seeing exactly what it saw before.
	 *  - `true` ⇒ the archive view: ONLY soft-deleted rows list
	 *    (`deleted_at IS NOT NULL`). There is no "both" value — mixing live and
	 *    tombstoned rows into one page would force every consumer to re-derive
	 *    "is this archived" from `deletedAt` instead of the deliberate,
	 *    filterable either/or a merchant actually wants (browse the catalog,
	 *    or browse the archive — never both at once).
	 */
	deleted?: boolean;
}

/** A keyset cursor POSITION — the `(createdAt, productId)` of the last row of
 *  the previous page. Deliberately opaque-free in the domain (NO base64), like
 *  `OrderListCursor` — the service layer wraps this into an opaque token.
 *  Ordering is `created_at DESC, product_id DESC`, so the next page is every
 *  row strictly "less than" this position under that order. */
export interface ProductListCursor {
	createdAt: string;
	productId: ProductId;
}

/** One page request: an optional starting cursor (null/absent ⇒ first page)
 *  and a page size. */
export interface ProductListPage {
	cursor?: ProductListCursor | null;
	limit: number;
}

/**
 * A lightweight product row for the admin list — a PROJECTION, not the full
 * `ProductCommerce`: only what the console table needs, so the list is one
 * statement and never N+1s into `inventory` per row (stock is deliberately
 * OMITTED here — see `ProductCommerceStore.listProducts`'s doc; the detail
 * leaf reads it via `InventoryStore.getOnHand` for the ONE product opened).
 * Money stays branded `Money` (never a bare number), nullable exactly like
 * the stored row (a "create then price" product may have neither sku nor
 * price yet).
 */
export interface ProductSummary {
	productId: ProductId;
	sku: Sku | null;
	title: string | null;
	price: Money | null;
	productKind: ProductKind;
	active: boolean;
	/**
	 * The soft-delete tombstone timestamp (admin-UX Increment 2, "product
	 * lifecycle surfacing"), ISO-8601 text like `createdAt` (never a `Date` —
	 * this is a wire-adjacent projection, not the full `ProductCommerce` row).
	 * Null for every LIVE row; non-null ONLY when `ProductListFilter.deleted:
	 * true` requested the archive view (the default list never returns a
	 * tombstoned row, so this field is null on every row of a default page —
	 * present unconditionally, not "sometimes on the wire", so a consumer never
	 * has to guess whether the field exists before reading it).
	 */
	deletedAt: string | null;
	createdAt: string;
}

export interface ProductListResult {
	products: ProductSummary[];
	/** The position to pass back for the next page, or null when this is the
	 *  last page (fewer than `limit + 1` rows matched). */
	nextCursor: ProductListCursor | null;
}

/** v1 scope — no variations (Phase 1 §2/§4). */
export type ProductKind = "physical" | "digital";

/**
 * How a product behaves when its available stock hits zero (product data-model
 * adds, Increment 2 slice 5).
 *
 * DELIBERATELY A ONE-VALUE UNION for now — `"deny"` is the ONLY behavior this
 * slice ships, and it is the ONLY value any adapter, the service enum, or the
 * edit-form select accepts. The field EXISTS end-to-end (stored, edited,
 * surfaced) so a merchant can see the store's stance and so a future
 * backorder slice has a column to widen — but `allow_backorder` is
 * NOT implemented here on purpose: the no-oversell invariant (CLAUDE.md
 * headline contract) is enforced by the reserve guard, and letting stock go
 * negative is a deep concurrency design question that needs its OWN races and
 * an ADR. Widening this union to `"deny" | "allow"` is a future slice's job,
 * gated on `allow` actually doing something defined; until then the type
 * itself makes an `"allow"` value unrepresentable rather than silently
 * accepted-and-ignored.
 */
export type InventoryPolicy = "deny";

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
	/**
	 * Product title (Phase 4 §4): the commercial projection of the CMS content
	 * title, and the source an order line snapshots at purchase time. Optional +
	 * nullable like every other commercial field (undefined preserves, null
	 * clears); "create then price" may land a row before a title exists.
	 */
	title?: string | null;
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

/**
 * The commerce fields a standalone admin EDIT page may update (admin-UX
 * Increment 2, slice 2 — the product edit surface). A STRICT SUBSET of
 * `UpsertProductCommerceInput`: only the fields our commerce domain OWNS.
 * Deliberately EXCLUDES:
 *  - `productId` — the CMS content link key (§4); identity, threaded as the
 *    target, never an editable field.
 *  - `active` — the CMS PUBLISH GATE, owned by `content:afterPublish` /
 *    `content:afterUnpublish` (→ `activate`/`deactivate`). A merchant toggle
 *    here would be silently overwritten by the next publish/unpublish sync, so
 *    `active` is NOT a domain-owned editable field — it is edited by publishing
 *    the CMS document, not on this page.
 *  - `contentUpdatedAt` — a CMS-sync ordering watermark, never merchant intent.
 * Partial-update grain matches `upsert`: `undefined` PRESERVES the stored value,
 * an explicit `null` CLEARS a nullable field. `sku`/`price` cannot be cleared
 * to null once set (no "unprice" case in scope). A raw `number` price is a
 * compile error — `price.amount` is branded `Cents`.
 */
export interface UpdateProductCommerceFieldsInput {
	productId: ProductId;
	sku?: Sku;
	price?: Money;
	title?: string | null;
	taxClass?: string | null;
	/**
	 * Optional "compare-at" / was-price (product data-model adds, Increment 2
	 * slice 5) — the struck-through reference price a discount is shown against.
	 * MUST share the product's own currency (the same atomic currency-integrity
	 * axis `price` carries — see `ProductCommerceUpdateResult.currency_mismatch`);
	 * a mismatched currency is rejected, never silently coerced. `undefined`
	 * PRESERVES, an explicit `null` CLEARS. Storefront strikethrough rendering is
	 * OUT of scope for this slice (data model + admin edit only). `compareAt <
	 * price` is the normal case, but `compareAt >= price` is DELIBERATELY NOT
	 * rejected (Shopify allows it — a "was" price can legitimately be ≤ the
	 * current one during a price rise); the admin form shows a soft warning
	 * rather than blocking the save.
	 */
	compareAtPrice?: Money | null;
	/**
	 * Optional merchant unit cost / cost-of-goods (product data-model adds,
	 * Increment 2 slice 5) — ADMIN-ONLY margin data. MUST share the product's
	 * currency (same integrity axis as `price`/`compareAtPrice`). `undefined`
	 * PRESERVES, `null` CLEARS. NEVER exposed on any storefront-facing read path:
	 * it is absent from `ProductCommerceView` (the catalog wire) and from the
	 * public `GET /products/:id/commerce` serialization — only the internal-token
	 * admin product detail carries it. Kept off the wire the buyer can see, by
	 * construction and pinned by a test.
	 */
	unitCost?: Money | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: ProductKind;
	/**
	 * The out-of-stock policy (product data-model adds, Increment 2 slice 5).
	 * Only `"deny"` is a legal value this slice (the `InventoryPolicy` union has
	 * no other member); the field round-trips end-to-end but changes NO
	 * reservation semantics — the no-oversell guard is untouched. `undefined`
	 * PRESERVES the stored value.
	 */
	inventoryPolicy?: InventoryPolicy;
}

/**
 * Outcome of a guarded admin edit (`ProductCommerceStore.updateCommerceFields`).
 * A discriminated union rather than a bare row so the admin plugin renders each
 * case without status-code-as-logic:
 *  - `ok` — applied (or a same-key replay no-op), carrying the current row.
 *  - `not_found` — no LIVE row for this `product_id` (unknown or soft-deleted);
 *    an edit is not a create (that is `upsert`'s job), so no row is minted.
 *  - `stale` — the optimistic compare-and-set on `updatedAt` failed: another
 *    writer (a second admin edit, a CMS sync, a publish flip) changed the row
 *    since the admin loaded the detail. `current` is the fresh row to reload.
 *  - `currency_mismatch` — a money edit would leave the row holding MIXED
 *    currencies; `current` carries the stored row. Three sub-cases, all the
 *    same integrity axis (CLAUDE.md money rule — currency is NEVER silently
 *    switched or mixed):
 *      · a `price` update tried to change an already-priced product's currency;
 *      · a `compareAtPrice`/`unitCost` update disagreed with the product's price
 *        currency (or was supplied for a product that has no price currency yet
 *        — compare-at / cost require the product to be priced first, so there is
 *        a currency to match). A deliberate re-currency is out of scope.
 *    (A single edit that supplies several money fields in DIFFERENT currencies
 *    is caught earlier, as an `InvalidProductFieldError` 400 — a client bug, not
 *    a stored-state conflict.)
 */
export type ProductCommerceUpdateResult =
	| { ok: true; product: ProductCommerce }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; current: ProductCommerce }
	| { ok: false; reason: "currency_mismatch"; current: ProductCommerce };

/** The stored row (Phase 1 §4 schema), as read back from a store. */
export interface ProductCommerce {
	productId: ProductId;
	sku: Sku | null;
	price: Money | null;
	/** Snapshot source for an order line's title (Phase 4 §4); null until set. */
	title: string | null;
	/** References a `TaxClass.id` (the `TaxRulesStore` registry); null ⇒ the
	 *  checkout pipeline treats the line as `"standard"`. */
	taxClass: string | null;
	/** Optional compare-at / was-price (Increment 2 slice 5). Shares the
	 *  product's price currency; display-only for now. Null until set. */
	compareAtPrice: Money | null;
	/** Optional admin-only unit cost (Increment 2 slice 5). Shares the product's
	 *  price currency. NEVER on a storefront-facing wire. Null until set. */
	unitCost: Money | null;
	/** Out-of-stock policy (Increment 2 slice 5). Always `"deny"` this slice —
	 *  the field exists but changes no reservation semantics. */
	inventoryPolicy: InventoryPolicy;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: ProductKind;
	/** The publish gate (§6 step 7): `content:afterPublish` flips it true via
	 *  `ProductCommerceStore.activate`, `content:afterUnpublish` flips it back
	 *  false via `deactivate`. New/soft-deleted/unpublished = false. */
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
	/**
	 * The publish gate (Phase 1 §4: flipped true by `content:afterPublish`,
	 * via `ProductCommerceStore.activate`; Phase 2 §4.2: "purchasable: false
	 * iff commerce === null (or explicitly inactive)"). The store RETURNS
	 * inactive rows, flagged — the ONE place purchasability is decided is the
	 * plugin's `joinProduct` (`purchasable ⟺ commerce !== null &&
	 * commerce.active`), so listing visibility and sellability stay separate
	 * concerns.
	 */
	active: boolean;
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
	/**
	 * Bulk snapshot read (checkout §4) — a query, not a command: mutates
	 * nothing, carries no idempotency key. The batch companion to
	 * `getByProductId`, so the two checkout paths (`createOrderFromCart` and
	 * `POST /checkout/quote`) fetch every cart line's product projection in ONE
	 * store round trip instead of one per line (the per-cart-line N+1 this
	 * method exists to kill).
	 *
	 * Returns the FULL `ProductCommerce` per id — title / taxClass / productKind
	 * included (UNLIKE `listCommerceByIds`, whose narrower `ProductCommerceView`
	 * drops them) — because each caller snapshots price + title and branches on
	 * `productKind` per line.
	 *
	 * Identical row semantics to `getByProductId`, NOT `listCommerceByIds`: this
	 * is the RAW row read. It does NOT filter on `deleted_at`, `sku`, or `price`
	 * and applies no commerce-complete guards — a soft-deleted, unpriced, or
	 * sku-less row is returned as-is, because the callers do their own per-line
	 * null / price / currency / kind checks (a store-side guard here would
	 * silently turn a "row exists but isn't sellable" into a caller-visible
	 * absence and change which failure reason the checkout returns).
	 *
	 * MISSING ids are ABSENT from the Map — never a null entry, never an error
	 * (mirroring `getByProductId` returning null for a single miss). Duplicate
	 * input ids collapse to one entry. NO ordering guarantee; look results up by
	 * id, never by position.
	 */
	getManyByProductId(productIds: ProductId[]): Promise<Map<ProductId, ProductCommerce>>;
	/** Soft delete: sets `deletedAt` + `active=false`; retains the row. A
	 *  replay with the same key (or an already-deleted / unknown row) is a
	 *  no-op. */
	softDelete(productId: ProductId, key: IdempotencyKey): Promise<void>;
	/**
	 * Guarded admin EDIT of the commerce-owned fields (admin-UX Increment 2,
	 * slice 2 — the standalone product edit page). UNLIKE `upsert` (a CMS-sync /
	 * field-widget insert-or-update, last-writer-wins), this is an EDIT of an
	 * EXISTING live product under an OPTIMISTIC compare-and-set on `updatedAt`
	 * (the `OrderStore` `expectedFlag` compare-and-set precedent). Guard order —
	 * MUST be identical in every adapter (contract-pinned):
	 *  1. Unknown or soft-deleted `product_id` → `not_found` FIRST (never mints a
	 *     row — an edit is not a create; that is `upsert`'s job). This outranks
	 *     the replay check: a same-key replay arriving AFTER the row was
	 *     (soft-)deleted reports `not_found`, never a spurious `ok` over a
	 *     tombstone (matching the SQL adapter, whose `deleted_at IS NULL` UPDATE
	 *     guard makes a deleted row unreachable regardless of the stored key).
	 *  2. Idempotent replay: if the LIVE row's stored `idempotency_key` equals
	 *     `key`, the edit already applied — a no-op returning the stored row as
	 *     `ok`. A double-submit dedupes, and the stale guard never fires on a
	 *     replay even though `updatedAt` has since advanced.
	 *  3. `updatedAt` (ISO-8601 text) != `expectedUpdatedAt` → `stale`, carrying
	 *     the current row: another edit/sync/lifecycle write landed since the
	 *     admin loaded the detail. The lost-update guard — the deliberate
	 *     DIVERGENCE from `upsert`'s accepted last-writer-wins panel semantics.
	 *  4. a money-currency conflict → `currency_mismatch` (CLAUDE.md money rule —
	 *     currency is an integrity axis, never silently switched or mixed):
	 *      a. a `price` whose currency differs from the STORED price's currency
	 *         (only when a price is already set — a first pricing accepts any
	 *         currency); OR
	 *      b. a `compareAtPrice`/`unitCost` supplied WITHOUT a `price` in the same
	 *         edit whose currency differs from the stored price currency — which
	 *         includes the "product not priced yet" case (stored price currency
	 *         NULL ⇒ nothing to match ⇒ mismatch: compare-at / cost require the
	 *         product to be priced first). When a `price` IS in the same edit, the
	 *         within-edit currencies were already checked upstream
	 *         (`InvalidProductFieldError`), and the price guard (4a) fixes the row
	 *         currency, so compare-at / cost inherit it with no separate store
	 *         guard.
	 *  5. otherwise → applies the partial update, stamps `key` as the row's
	 *     last-applied replay key, bumps `updatedAt`, returns the updated row.
	 * NEVER touches `active`/`deletedAt`/`contentUpdatedAt`/`active_updated_at`
	 * (the publish-gate + sync axes; a commerce edit is orthogonal to them). A
	 * live-SKU collision throws `SkuConflictError` — the same partial-index guard
	 * `upsert` surfaces. `expectedUpdatedAt` is the `updatedAt` the admin read on
	 * the detail (strict `Date.toISOString()` form — the wire round-trips it
	 * unchanged), compared as raw ISO text (lexical = chronological) on both
	 * dialects.
	 */
	updateCommerceFields(
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductCommerceUpdateResult>;
	/**
	 * The afterPublish→activate follow-up (Phase 1 §4/§6 step 7, deferred at
	 * the time `upsert`/`softDelete` landed — this is that task): flips a LIVE
	 * row to `active=true`. Deliberately a SEPARATE method from `upsert`, not
	 * an extra field on `UpsertProductCommerceInput` — `upsert` intentionally
	 * never touches `active`/`deletedAt` (a stale/replayed `content:afterSave`
	 * must never reactivate a row a merchant has since soft-deleted; see the
	 * port's `UpsertProductCommerceInput` doc).
	 *
	 * `contentUpdatedAt` is the CMS content's own `updatedAt` at publish time
	 * (an opaque ISO-8601 string; lexicographic comparison IS chronological),
	 * carried by `content:afterPublish`. It is the ORDERING WATERMARK for the
	 * publish gate, and it is load-bearing: `activate`/`deactivate` are
	 * OPPOSING transitions on the same `active` flag, delivered by independent
	 * fire-and-forget hook POSTs, so a rapid publish→unpublish toggle (or hook
	 * reordering / overlapping deferred runs) can land a stale `activate` AFTER
	 * a newer `deactivate`. A structural `active=0`/`active=1` guard alone
	 * would let that stale POST re-flip the row and leave an unpublished
	 * product purchasable with no self-heal — the one-way-latch failure this
	 * task exists to kill (plan §4 / §8 Risk 3: out-of-order delivery
	 * converges). EmDash's `publish()`/`unpublish()` BOTH bump the content's
	 * `updated_at` unconditionally, so every lifecycle event carries a strictly
	 * newer watermark than the one before it — a monotonic gate. This watermark
	 * is tracked in a DEDICATED store column, separate from `upsert`'s
	 * `contentUpdatedAt` (a plain `content:afterSave` advances that one WITHOUT
	 * being a lifecycle event, so sharing it would let a save poison the gate).
	 * Semantics:
	 *  - unknown `product_id` → no-op (no row minted; `content:afterPublish`
	 *    can race ahead of a not-yet-applied `content:afterSave` on a flaky
	 *    link — plan §4 "out-of-order delivery converges" / §8 Risk 3; without
	 *    a reconcile cron yet, this specific race is a known, documented gap
	 *    healed only by a later save/publish of the same product, exactly like
	 *    `content:afterSave`'s own failure story).
	 *  - a SOFT-DELETED row → no-op — **the load-bearing invariant**: publish
	 *    of a soft-deleted product must never resurrect it.
	 *  - already-`active` row → no-op (stable under replay).
	 *  - a STALE watermark (strictly older than the gate watermark a newer
	 *    lifecycle event already applied) → no-op: a delayed/re-ordered publish
	 *    can never re-activate a row a newer unpublish has since deactivated.
	 *  - otherwise → `active=true`, advancing the gate watermark to
	 *    `contentUpdatedAt` and stamping `key` as the row's "last applied"
	 *    replay key (the same per-row, non-unique field `upsert`/`softDelete`
	 *    already share — Phase 1 §4).
	 */
	activate(productId: ProductId, key: IdempotencyKey, contentUpdatedAt: string): Promise<void>;
	/**
	 * The afterUnpublish→deactivate follow-up (Phase 1 §4/§6 step 7): the exact
	 * mirror of `activate`, closing the publish gate. Flips a LIVE, active row
	 * back to `active=false` so an unpublished product is no longer purchasable
	 * (without it `active` would be a one-way latch — an unpublished product's
	 * row would stay `active=true` and `joinProduct` would still report it
	 * purchasable on a direct product-page hit). Order-aware under the same
	 * dedicated gate watermark as `activate` (`contentUpdatedAt` = the content's
	 * `updatedAt` at unpublish time — see `activate` for why opposing boolean
	 * transitions DO need a "which value is newer" watermark):
	 *  - unknown `product_id` → no-op (no row minted; `content:afterUnpublish`
	 *    can race ahead of a not-yet-applied `content:afterSave` on a flaky
	 *    link — the same documented out-of-order gap `activate` carries).
	 *  - a SOFT-DELETED row → no-op — the tombstone is left untouched: an
	 *    unpublish neither resurrects a deleted row nor re-stamps its key.
	 *  - already-`active=false` row → no-op (stable under replay).
	 *  - a STALE watermark (strictly older than the gate watermark a newer
	 *    lifecycle event already applied) → no-op: a delayed/re-ordered
	 *    unpublish can never deactivate a row a newer publish has since
	 *    re-activated.
	 *  - otherwise → `active=false`, advancing the gate watermark to
	 *    `contentUpdatedAt` and stamping `key` as the row's "last applied"
	 *    replay key. This flips ONLY the publish gate; `deletedAt` is never
	 *    touched — deactivation is not a soft delete.
	 */
	deactivate(productId: ProductId, key: IdempotencyKey, contentUpdatedAt: string): Promise<void>;
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
	 * Inactive (unpublished) rows ARE returned, carrying `active: false` —
	 * the store reports state; the purchasability DECISION lives in one
	 * place, the plugin's `joinProduct` gate (see `ProductCommerceView.active`).
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

	/**
	 * Admin Products console list (view-only; admin-UX Increment 2 — the missing
	 * enumerate primitive). Returns a keyset-paginated page of lightweight
	 * `ProductSummary` PROJECTIONS (never the full `ProductCommerce`, and never
	 * joined with `inventory` — the list must not N+1 into stock per row; a
	 * per-row stock signal is deferred to the detail leaf's single-sku
	 * `InventoryStore.getOnHand` read). Excludes soft-deleted rows
	 * (`deleted_at IS NULL`) by DEFAULT — mirrors `listCommerceByIds`'s
	 * tombstone discipline — UNLESS `filter.deleted: true` requests the archive
	 * view (`deleted_at IS NOT NULL` instead), the "product lifecycle
	 * surfacing" slice's one new axis: browse what was soft-deleted (there is
	 * still no RESTORE — a soft delete's `active`/`deletedAt` are flipped only
	 * by the CMS-sync/lifecycle paths, `softDelete`/`activate`/`deactivate`;
	 * this list is read-only visibility, not a new mutation).
	 *
	 * Ordered `created_at DESC, product_id DESC` (newest-first, `product_id`
	 * the stable tie-break — the primary key, exactly like `OrderSummary.id`).
	 * This is the ONLY sort this slice offers: `title` would be the natural
	 * catalog-browsing alternative, but `title` is NULLABLE ("create then
	 * price" may land a row before a title exists), and a keyset cursor over a
	 * nullable column needs NULLS-LAST handling that both dialects would have
	 * to agree on for no real benefit yet — deferred as a follow-up, not
	 * "sortable where cheap" for this slice. `created_at` is NOT NULL, so this
	 * ordering needs no such handling and is a byte-for-byte mirror of
	 * `listOrders`'s proven keyset shape.
	 *
	 * Pagination is forward-only keyset: the caller passes back the previous
	 * page's `nextCursor` position; the adapter fetches `limit + 1` rows to
	 * decide whether a next page exists and emits `nextCursor` from the LAST
	 * RETURNED row (null when the page is the last).
	 */
	listProducts(filter: ProductListFilter, page: ProductListPage): Promise<ProductListResult>;

	/**
	 * Count LIVE (non-soft-deleted) products whose `tax_class` references this
	 * `taxClassId` (product data-model adds, Increment 2 slice 5). A query, not a
	 * command — no idempotency key, mutates nothing.
	 *
	 * The delete-in-use guard for the tax-class registry: `deleteTaxClass`
	 * composes this with `TaxRulesStore.deleteClass` so a class a product still
	 * points at can never be deleted out from under it (which would strand the
	 * product on a dangling reference and silently reclassify its tax at the next
	 * checkout). Counts LIVE rows only — a soft-deleted product's tax reference is
	 * historical, not a live dependency, so it does not block reclaiming the class
	 * id. `0` ⇒ no live product references the class.
	 */
	countByTaxClass(taxClassId: string): Promise<number>;
}
