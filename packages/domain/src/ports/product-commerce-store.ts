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
 * `search` and `OrderListFilter.search` (an order-id PREFIX, a case-folded
 * `buyer_ref` SUBSTRING, or an exact case-folded purchase-time line SKU) have
 * converged on both shapes they share. A `title` is free text a merchant
 * partially remembers, so it matches as a case-insensitive SUBSTRING, exactly
 * as an order's `buyer_ref` does; and `sku` is a structured identifier a
 * merchant quotes whole, so it stays an exact, case-insensitive match — which
 * is now the SAME rule the orders list applies to the sku frozen on an order
 * line, making `sku` the axis on which the two searches AGREE rather than the
 * one where they part. Neither takes the order id's PREFIX treatment (a sku is
 * short and readable and renders in full, where an order uuid renders only as a
 * short prefix). The two lists still read that sku from different TABLES — this
 * one from the live catalogue row, the orders list from the purchase-time
 * snapshot on `order_items` — so a rename moves this list's rows and not that
 * one's. A row matches if EITHER half matches (never both required).
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
	/**
	 * Low-stock predicate parameter — the rule behind the admin console's "Low
	 * stock only" filter, applied by the DATABASE so it selects across the whole
	 * catalog rather than trimming rows a page already fetched. The threshold is
	 * the store's SINGLE GLOBAL scalar
	 * (`SettingsStore.lowStockThreshold`), never a per-product reorder point —
	 * this store does not read settings itself; the CALLER resolves the
	 * threshold and passes the number through, exactly like every other value
	 * on this filter.
	 *
	 * DOMAIN: a NON-NEGATIVE INTEGER — mirrors the HTTP boundary's own
	 * validation (`packages/service/src/schemas.ts`'s `lowStockQuery` /
	 * `settingsBody`: `z.number().int().nonnegative()`), and the ONLY domain
	 * every adapter agrees on. A value outside it (fractional, negative,
	 * `NaN`, `±Infinity`) throws `InvalidLowStockThresholdError` — checked by
	 * EVERY adapter via the shared `isValidLowStockThreshold` guard, BEFORE
	 * any comparison or query runs — never a silent per-adapter answer: a raw
	 * fractional threshold applies cleanly in a naive fake/SQLite comparison
	 * but Postgres rejects it binding an `integer` column, and a raw `NaN`
	 * threshold would silently mean "everything passes" in a naive fake
	 * (`onHand > NaN` is always false) and "nothing passes" in SQLite — three
	 * different answers to one input, which is what the shared guard exists
	 * to make unreachable. Contract-pinned so the three can never drift apart.
	 *
	 * NOT YET ENFORCED AT THIS FILTER'S OWN HTTP BOUNDARY: `lowStockQuery` and
	 * `settingsBody` (above) constrain the OTHER two `lowStockThreshold`
	 * call sites, but `productListFilterSchema` in `packages/service/src/
	 * schemas.ts` — the schema this filter's own list/count query param would
	 * parse through — has no `lowStockThreshold` field at all yet, so it
	 * cannot reject a bad one before this port does. Whichever increment wires
	 * a query param to this field MUST add the same `z.number().int()
	 * .nonnegative()` there and map `InvalidLowStockThresholdError` to a 400,
	 * or a bad value 500s instead of 400s.
	 *
	 * A row matches iff BOTH hold:
	 *  - its sku resolves to a KNOWN `inventory` row — the same LEFT JOIN
	 *    `ProductSummary.onHand` is sourced from. A product with NO inventory
	 *    row (or no sku at all — a "create then price" row) is UNKNOWN stock,
	 *    never "low": absent is not zero (see `ProductSummary.onHand`'s doc).
	 *    Folding the two would render every never-synced/unpriced sku as
	 *    artificially urgent.
	 *  - `on_hand <= lowStockThreshold` — INCLUSIVE, so a sku stocked exactly
	 *    at the threshold counts as low, and `on_hand === 0` ("out of stock",
	 *    a KNOWN fact) always matches a non-negative threshold.
	 *
	 * A SECOND, DELIBERATELY DIFFERENT "low stock" lives at
	 * `ReportingStore.lowStock(threshold)`: that report is INVENTORY-first (an
	 * orphan sku with no live product still lists, ordered by `on_hand`),
	 * while this filter is PRODUCT-first (a rowless product is excluded,
	 * ordered by `created_at`). Both happen to be inclusive at the boundary
	 * today, so the two agree there — but they are independent definitions
	 * with independent absent-row rules, and a future change to either one's
	 * boundary or absent-row decision must update BOTH docs, not just one.
	 *
	 * OMITTED (`undefined`) ⇒ no stock-based filtering — the unchanged
	 * default every existing caller keeps seeing. This is also the correct
	 * behavior when a caller cannot resolve a threshold at all (settings
	 * unset/unreadable) — never treat "no threshold" as "threshold 0" (which
	 * would silently return only out-of-stock rows instead of the honest
	 * "can't filter" answer).
	 *
	 * THIS ONLY MIRRORS HALF of the plugin's `filterUnavailable` degradation
	 * (`canFilter = threshold !== null && !unreadable`) — specifically the
	 * "no threshold to filter by" cause. It does NOT, and cannot, mirror the
	 * OTHER cause (`unreadable`: every row's `onHand` missing on the WIRE) —
	 * that is a client-side projection concern, orthogonal to whether this
	 * predicate ran. Once a caller wires this field up, a page can be
	 * genuinely, correctly filtered by real `on_hand` values while the
	 * client's OWN `onHand` display column is still unreadable: the two
	 * causes are independent axes post-wiring, not one merged concept.
	 */
	lowStockThreshold?: number;
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
 * `ProductCommerce`: only what the console table needs, so the list stays ONE
 * statement (a single LEFT JOIN for stock — never an N+1 per row; see
 * `ProductCommerceStore.listProducts`'s doc). Money stays branded `Money`
 * (never a bare number), nullable exactly like the stored row (a "create then
 * price" product may have neither sku nor price yet).
 */
export interface ProductSummary {
	productId: ProductId;
	sku: Sku | null;
	title: string | null;
	price: Money | null;
	productKind: ProductKind;
	active: boolean;
	/**
	 * Stock on hand for this row's sku — a COUNT, never money (no `Cents`
	 * brand, no currency; it must never reach a money field).
	 *
	 * `null` means "unknown": there is NO `inventory` row for this sku (or the
	 * product has no sku at all — a "create then price" row). That is a
	 * DIFFERENT fact from `0`, which means a known sku that is out of stock.
	 * Callers must never conflate the two: rendering `null` as `0` invents an
	 * out-of-stock claim, and rendering `0` as unknown hides one. The two are
	 * pinned separately by the contract suite.
	 *
	 * ⚠ This DIVERGES, deliberately, from `InventoryStore.getOnHand`, which
	 * returns a bare `number` and therefore collapses "no inventory row" to
	 * `0`. That method serves the detail leaf, where the ONE product is
	 * already known; this projection serves a list that must show the
	 * difference. The divergence is documented on BOTH sides — do not
	 * "harmonize" them by coercing `null → 0` here.
	 *
	 * Sourced by a single LEFT JOIN onto `inventory` in the same statement as
	 * the page — the join miss IS the null. Measured cost of carrying it at
	 * page size 25 over 5,000 products / 3,997 inventory rows on Postgres 16:
	 * p50 0.43 → 0.58 ms, p95 0.61 → 0.91 ms (an N+1 of per-row `getOnHand`
	 * reads was 2.60 ms p50 parallel / 6.36 ms sequential — 6× and 15× the
	 * baseline, which is why the join is the shape). No new index: the join's
	 * inner side is already `inventory`'s primary key.
	 */
	onHand: number | null;
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
	 * Product title (Phase 4 §4) — a DERIVED CACHE of the CMS content title, and
	 * the source an order line snapshots at purchase time.
	 *
	 * THIS IS THE ONLY CHANNEL THAT MAY WRITE IT. Title is owned by the CMS
	 * `products` collection; `product_commerce.title` is a single-writer cache
	 * maintained solely by the `content:afterSave` / `content:afterPublish` sync,
	 * which reaches this input through `PUT /products/:id/commerce`. The guarded
	 * admin edit (`UpdateProductCommerceFieldsInput`) deliberately has no `title`
	 * field, so there is no second writer to diverge from.
	 * Reasoning: `adr/0013-product-title-is-cms-owned.md`.
	 *
	 * Optional + nullable like every other commercial field (undefined preserves,
	 * null clears); "create then price" may land a row before a title exists.
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
 *  - `title` — CMS-OWNED, exactly like `active` and for exactly the same
 *    reason. `product_commerce.title` is a derived single-writer cache fed by
 *    the `content:afterSave` / `content:afterPublish` sync (see
 *    `UpsertProductCommerceInput.title`, the one sanctioned channel). A
 *    merchant edit here would be silently overwritten by the next CMS save, so
 *    the title is edited by renaming the CMS document, not on this page; the
 *    admin console shows it as a READ-ONLY row beside Status. The column is not
 *    dropped because an order line must snapshot a title without a
 *    cross-database read. Full reasoning, including why dropping the column was
 *    considered and rejected: `adr/0013-product-title-is-cms-owned.md`.
 *  - `contentUpdatedAt` — a CMS-sync ordering watermark, never merchant intent.
 * Partial-update grain matches `upsert`: `undefined` PRESERVES the stored value,
 * an explicit `null` CLEARS a nullable field. `sku`/`price` cannot be cleared
 * to null once set (no "unprice" case in scope). A raw `number` price is a
 * compile error — `price.amount` is branded `Cents`.
 */
export interface UpdateProductCommerceFieldsInput {
	productId: ProductId;
	/**
	 * The product's stock-keeping unit. Supplying a DIFFERENT value than the row
	 * holds is a RENAME, and a rename is never just a string swap: `inventory` is
	 * keyed by this exact natural key, so the row's on-hand count is carried onto
	 * the new sku in the SAME transaction as this edit, or the edit is refused
	 * (`SkuStockConflictError`) — see `ProductCommerceStore.updateCommerceFields`
	 * for the full rule. `undefined` PRESERVES the stored sku; there is no
	 * "unsku" case (a sku cannot be cleared back to null once set).
	 */
	sku?: Sku;
	price?: Money;
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
	 * current one during a price rise); the admin form's STATIC help copy
	 * documents that this is allowed (no value-triggered warning is rendered —
	 * a dynamic per-save hint is a possible future UX nicety, not this slice).
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
	/** DERIVED CACHE of the CMS content title, with a SINGLE writer — the
	 *  `content:afterSave`/`content:afterPublish` sync, via `upsert` (Phase 4 §4;
	 *  `adr/0013-product-title-is-cms-owned.md`). It exists so an order line can
	 *  snapshot a title at purchase time without a cross-database read. Never
	 *  merchant-editable, and eventually consistent: a failed sync leaves a stale
	 *  value until the next save/publish. Null until the first sync carries one. */
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
 *
 * A SKU NAMES EXACTLY ONE LIVE SELLABLE UNIT, AND THE RULE IS BIDIRECTIONAL.
 * Since variants exist, "live sellable unit" spans live `product_commerce` rows
 * AND live (non-orphaned) `product_variants` rows, so uniqueness has to hold
 * across the pair or it holds nowhere: a sku a live VARIANT already carries is
 * refused to BOTH product-level writers (`upsert` and `updateCommerceFields`)
 * with the same `SkuConflictError` the variant writer raises in the opposite
 * direction. Checking only one direction would leave the other open, and two
 * sellable units over one `inventory` row is precisely the state THE SKU-RENAME
 * RULE cannot then reason about — a later rename of either one carries the
 * other's stock away, silently.
 *
 * The cross-table half cannot be an index (no dialect indexes across two
 * tables), so each adapter runs it as an explicit check inside the SAME
 * transaction as the write, positioned so it fires ONLY when the write actually
 * applies — a replayed, stale or watermark-rejected write moves no sku and must
 * refuse nothing. That is the same position the partial unique index occupies by
 * construction, so the two halves of the rule stay indistinguishable to a
 * caller. With no variant rows declared the check matches nothing, which is why
 * an unvarianted catalog behaves exactly as it did before.
 *
 * THE CURRENCY AXIS IS NOT SYMMETRIC ACROSS THE TWO PRODUCT-LEVEL WRITERS, and
 * that asymmetry predates variants. `updateCommerceFields` owns currency
 * integrity at product level and gains the reciprocal live-variant guard (its
 * clause 4c). `upsert` has never had a currency guard on ANY axis — it may
 * already switch an already-priced product's own currency silently, which is the
 * documented last-writer-wins stance of the integrator PUT and the CMS sync — so
 * bolting a variant-only currency refusal onto it would refuse the cross-ROW
 * case while still permitting the same-ROW case, in the same call. The sku axis
 * differs precisely because `upsert` DOES already refuse there
 * (`SkuConflictError` from the partial index), so extending that refusal across
 * the table is a widening of an existing rule rather than a new one. Giving
 * `upsert` a currency guard means giving it one on both axes at once, which is a
 * change to its own documented semantics and belongs to its own decision.
 *
 * THE SKU-RENAME RULE, shared by BOTH writers of `sku` (`upsert` and
 * `updateCommerceFields`) — a property of the COLUMN, not of one caller, so
 * neither writer may skip it. When a write changes a row's `sku` from one
 * non-null value to another, the adapter MUST, in the SAME transaction as the
 * product-row write:
 *  0. REFUSE while any LIVE (`held`/`adopted`) reservation still references the
 *     SOURCE sku — `SkuHeldStockError`, naming the sku and how many. A hold's
 *     units are already OUT of `on_hand`, so the carry cannot move them, and the
 *     hold cannot follow the rename (`reservations.sku` references
 *     `inventory.sku`, so it can be neither re-keyed nor deleted). Left alone,
 *     every later transition on that hold lands on the row the rename emptied: a
 *     release credits units back to a sku no product owns, and an upward adjust
 *     fails OUT_OF_STOCK against a zero the shopper cannot see. Every hold does
 *     end on its own — a cart hold expires on its deadline and the sweep
 *     releases it; an adopted hold resolves when its order does — but "ends on
 *     its own" is not "ends soon": an adopted hold lives as long as the order
 *     awaits payment, so a product with an order in flight can stay unrenameable
 *     for as long as that order does. Migrating the holds instead was rejected —
 *     see `SkuHeldStockError`.
 *  1. CLAIM the target sku's inventory row. If a row already exists there the
 *     whole write is REFUSED with `SkuStockConflictError` naming both skus —
 *     nothing is renamed, nothing moves. Occupied is occupied: the refusal does
 *     NOT depend on the quantity, because a row holding `0` is still a row
 *     ("known sku, out of stock" — a different fact from "no such sku") and may
 *     already be referenced by reservations and order lines. Merging the two
 *     counts would invent a stock figure, and picking a winner would discard
 *     one; the operator decides instead.
 *  2. CARRY the source sku's on-hand count onto the target. Without this a
 *     rename strands the units under a sku no product owns while the product
 *     starts again from zero — silent inventory loss with nothing on screen.
 *  3. RETAIN the source row, zeroed. A stock row is NEVER deleted and never
 *     re-keyed: `reservations.sku` references `inventory.sku`, so the rows a
 *     sold sku leaves behind are load-bearing history.
 * A write that changes nothing (same sku), applies nothing (a same-key replay,
 * a stale-watermark sync no-op, `not_found`, `stale`, `currency_mismatch`), or
 * sets the FIRST sku on a row that had none carries nothing — the carry follows
 * the ROW's before/after sku, never the input's. A source sku with no inventory
 * row has nothing to carry; the claimed target row simply stays at `0`, which
 * is the row `InventoryStore.seedOnHand` would have created a moment later
 * anyway (that always-attempt seed stays UNCONDITIONAL — the carry never turns
 * it into a conditional write; see `upsertProductCommerce` /
 * `updateProductCommerceFields`).
 *
 * THE FIRST-SKU ASYMMETRY, deliberate and pinned by the contract suite. Setting
 * the FIRST sku on a row that had none is NOT a rename, so none of the above
 * runs — and if that sku already has an inventory row, the product simply
 * ADOPTS it, units and all, where a rename onto the same row would have been
 * refused. This is the pre-existing seed/heal semantics, not a new decision:
 * `seedOnHand` is create-if-absent on the natural key, which is exactly how a
 * product re-linked to a sku it used to own gets its stock back after a failed
 * sync. Adoption is the ONLY way that heal can work, and there is no second
 * count to reconcile because the product had none. Renames refuse; first
 * assignment adopts. Changing it means designing the heal path a different way,
 * which is its own change.
 *
 * The same "there is no row yet" reasoning bounds what a CREATE can do: two
 * concurrent upserts that both create the SAME product with DIFFERENT skus
 * carry nothing either way, because neither finds a prior row to lock or a
 * prior sku to move from. The product ends on whichever write committed last,
 * with an empty inventory row under each sku that was named — no units exist to
 * strand, since a product only acquires them after it exists.
 *
 * WHAT THE CLAIM WAITS ON, because "it takes a lock" invites the wrong mental
 * model and the wrong worry. The claim waits only on a SAME-KEY speculative
 * insert: another transaction that has inserted the very same target sku and
 * not yet committed. It does NOT wait on a committed row (it conflicts and does
 * nothing), and the source lock waits on nothing at all when the source has no
 * row to lock. Crossed renames therefore cannot cycle — A→B and B→A claim
 * DIFFERENT keys, so neither ever waits on the other. Writes aimed at the SAME
 * target sku are the only ones that queue, and all but one of those is about to
 * be refused regardless.
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
	 *         guard; OR
	 *      c. a `price` whose currency differs from that of any LIVE VARIANT of
	 *         this product — the reciprocal of `updateVariantFields`'s guard 4b,
	 *         and required for the same reason it is: a product and its sizes are
	 *         one purchasable thing, so a repricing that would leave a live size
	 *         holding another currency is refused rather than rendered. Without
	 *         this direction the guard is trivially bypassed by repricing the
	 *         product instead of the size. Resolved under the parent row's lock —
	 *         the same lock, in the same order, that the variant path takes — so
	 *         a product repricing and a variant pricing cannot both pass by
	 *         reading each other's "before" state. With no variants declared it
	 *         matches nothing and this guard cannot fire.
	 *  5. otherwise → applies the partial update, stamps `key` as the row's
	 *     last-applied replay key, bumps `updatedAt`, returns the updated row —
	 *     and, when the update CHANGED the row's `sku`, carries that sku's
	 *     inventory row with it under THE SKU-RENAME RULE on this interface
	 *     (claim-or-refuse, carry, retain the source zeroed), inside this same
	 *     transaction. Only an applied update carries: every zero-row branch
	 *     above (including the replay `ok`) moves no stock, so a double-submitted
	 *     rename moves the units exactly once.
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
	 * `ProductSummary` PROJECTIONS (never the full `ProductCommerce`).
	 *
	 * STOCK: each row carries `onHand` via a single LEFT JOIN onto `inventory`
	 * in the SAME statement — one round trip per page, never an N+1 of per-row
	 * `InventoryStore.getOnHand` reads. The join is unconditional (not gated on
	 * a filter) and needs no new index; the LEFT half is load-bearing, because
	 * a sku with no inventory row must yield `onHand: null` ("unknown"), which
	 * is NOT the same fact as `0` ("out of stock"). `inventory.sku` is that
	 * table's primary key, so the join can never multiply a page's rows. The
	 * SAME join backs `filter.lowStockThreshold` (see that field's doc) — no
	 * second join, no separate query.
	 * Excludes soft-deleted rows
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
	 * Count the products matching a filter (INC-23: the admin list's exact
	 * "N products" caption). Shares the EXACT predicate with `listProducts` —
	 * same `active`/`deleted`/`productKind`/`search`/`lowStockThreshold`
	 * semantics, including the tombstone default — so a count can never
	 * disagree with the list it captions (one predicate builder in every
	 * adapter; mirrors `OrderStore.countOrders` 1:1).
	 *
	 * A SEPARATE method rather than a `total` on `ListResult`, deliberately: the
	 * count is a second statement, and folding it into the page read would
	 * charge every caller of `listProducts` for a `COUNT(*)` whether or not it
	 * renders one. The keyset page and the count are independent questions and
	 * stay independently callable.
	 *
	 * NO JOIN and no ordering by default — `listProducts`'s stock LEFT JOIN
	 * exists to fill a column, and a count has no columns. The join is added
	 * back CONDITIONALLY, only when `filter.lowStockThreshold` is set (the one
	 * axis a count cannot resolve without it), so every other predicate keeps
	 * the join-free plan this method was measured against.
	 *
	 * CAPTION HAZARD for every caller of this filter: this method returns a
	 * GENUINELY FILTERED total whenever `filter.lowStockThreshold` is set, and
	 * the UNFILTERED total when it is omitted — and the two are captioned
	 * differently. A caller that could not resolve a threshold and therefore
	 * omitted this field is holding an UNFILTERED total: it must not caption
	 * the list or the total as filtered in that case. The omission has to
	 * propagate all the way to the caption, not stop at the query.
	 */
	countProducts(filter: ProductListFilter): Promise<number>;

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

	// -- Variants: one commerce row per sellable unit --------------------------

	/**
	 * The CMS-SYNC channel for one variant (see {@link UpsertProductVariantInput}
	 * and `adr/0016-variant-title-is-cms-owned.md`): insert-or-update by
	 * `(productId, variantKey)`, idempotent under `key`, order-aware under
	 * `contentUpdatedAt`, and — because a variant EXISTS exactly while the CMS
	 * says it does — it is also the RESURRECT half of the presence axis:
	 *  - unknown `(productId, variantKey)` ⇒ a new row, with `sku`/`price` NULL
	 *    (a variant is DECLARED by the CMS and PRICED by the admin — this channel
	 *    can write neither, which is the whole of the decision).
	 *  - a same-`key` replay ⇒ a no-op returning the stored row unchanged.
	 *  - a STRICTLY OLDER `contentUpdatedAt` than the stored watermark ⇒ a stale
	 *    no-op, so out-of-order hook delivery converges (mirrors `upsert`).
	 *  - an ORPHANED row ⇒ RESURRECTED (`orphanedAt` back to null). This is the
	 *    deliberate DIVERGENCE from `softDelete` + `activate`, where a publish must
	 *    never resurrect a tombstone: THAT tombstone records a MERCHANT decision
	 *    that a CMS event must not override, while an orphan records the CMS's OWN
	 *    statement that the repeater row is gone — so the same channel that removed
	 *    it is the right one to bring it back, and refusing would strand the
	 *    variant's stock behind a key nobody can re-declare.
	 *
	 * THIS CHANNEL NEVER REFUSES PRESENCE AND NEVER THROWS A CONSTRAINT ERROR. A
	 * declare states a fact about the CMS — this key exists — and the commerce
	 * database does not get a vote on it. That is the whole reason the two clauses
	 * below exist rather than a refusal: while a variant was orphaned its sku was
	 * FREE for reuse (see `deactivateVariant`), so by the time it comes back the
	 * commerce facts it was carrying may no longer hold, and a resurrect that
	 * insisted on them would either raise a raw unique-index violation at the sync
	 * — an opaque 500 on a hook the merchant cannot see — or leave two live
	 * sellable units sharing one `inventory` row.
	 *
	 * So a resurrect REVALIDATES the stale commerce facts on the way back in, and
	 * CLEARS whatever no longer holds:
	 *  - the stored `sku` is KEPT when it is still free among live sellable units,
	 *    and CLEARED to null when another live variant or live product has taken
	 *    it since. An orphan cannot reclaim what was legitimately reused. This is
	 *    the ONE case where a sku goes back to null after being set: it is not an
	 *    edit clearing it (no writer can do that) but the row losing a claim it no
	 *    longer has, and the operator re-prices the size exactly as they would a
	 *    newly declared one.
	 *  - the stored `price` is CLEARED when its currency now conflicts with the
	 *    product's current currency (see `updateVariantFields` guard 4b for how
	 *    that currency is resolved) — the same integrity axis, and for the same
	 *    reason: a price the product can no longer honour is not a price.
	 * THE INVENTORY ROW IS NEVER TOUCHED by any of this. A kept sku keeps its
	 * units; a cleared sku leaves its `inventory` row exactly where it is, and
	 * re-assigning that sku later is governed unchanged by THE FIRST-SKU
	 * ASYMMETRY — a first sku ADOPTS the existing row, units and all, which is
	 * precisely how a variant re-linked to a sku it used to own gets its stock
	 * back.
	 *
	 * PRESENCE MOVES ONLY ON AN ORDERED, STRICTLY NEWER DELIVERY, and this is
	 * narrower than the title's own guard on purpose. The title is an unordered
	 * last-writer-wins cache, so a watermark-less save (a panel-style write) may
	 * update it. Presence is an axis with two OPPOSING transitions, so it needs
	 * the same treatment the publish gate gets: a resurrect applies only when the
	 * incoming `contentUpdatedAt` is present AND STRICTLY NEWER than the stored
	 * watermark (or the row has none yet). Two consequences, both load-bearing:
	 *  - a REDELIVERED watermark-less declare can never resurrect a variant a
	 *    newer save has since orphaned;
	 *  - a redelivered declare at an EQUAL watermark cannot resurrect either, so
	 *    the deactivate it raced with stays applied and a redelivery of THAT
	 *    command finds the row already orphaned and does nothing. Equal watermarks
	 *    across two different saves ARE possible where the CMS leaves `updatedAt`
	 *    frozen on a draft-only save (which is exactly why a resurrect needs the
	 *    strict comparison, and why re-declaring a key inside that window does not
	 *    take effect until the document is published), and one save can never both
	 *    declare and drop the same key.
	 * THE COST OF THE STRICT COMPARISON, so nobody has to discover it: re-sending
	 * the SAME save cannot repair an orphan that save caused in error, because its
	 * watermark is no longer strictly newer. The repair is a FRESH CMS save — any
	 * edit to the document, which bumps `updatedAt` and re-declares the key. That is
	 * the deliberate trade: a redelivery must never flip presence, so a redelivery
	 * cannot un-flip it either, and only a new decision by the CMS can.
	 *
	 * Rejects a missing/empty `productId` with `MissingProductIdError` and a
	 * missing/empty `variantKey` with `MissingVariantKeyError`, BEFORE any row is
	 * minted — the key is the identity, and an identity-less variant row could
	 * never be addressed again.
	 *
	 * NO PARENT-ROW CHECK, deliberately: a variant may land before its
	 * `product_commerce` row does (`content:afterSave` and the repeater's own
	 * delivery are independent fire-and-forget POSTs), exactly as `activate` may
	 * arrive before the row it publishes. Convergence is by the watermark, not by
	 * a foreign key that would abort instead.
	 */
	upsertVariant(input: UpsertProductVariantInput, key: IdempotencyKey): Promise<ProductVariant>;

	/**
	 * Every variant of one product — the Variants-tab read, and the projection a
	 * later "one row per sellable unit" list expands a product into.
	 *
	 * ORDERED `variant_key ASC`, the only stable order available: the key is
	 * immutable and unique within the product, while `created_at` moves with
	 * whichever sync happened to mint the row and a display name is a CACHE that
	 * may be null. Compared as plain text on both dialects (no casts, no
	 * collation clause), so keys that must sort predictably across dialects
	 * should stay within a character set the two agree on.
	 *
	 * INCLUDES ORPHANED ROWS, flagged by a non-null `orphanedAt` — surfacing the
	 * orphan is the point (it may hold stock and sit on live orders), and a
	 * caller that wants only sellable units filters on the field it can see.
	 *
	 * `onHand` comes from a LEFT JOIN onto `inventory` in the SAME statement —
	 * one round trip per product, never an N+1 of per-variant stock reads — and
	 * carries the identical three-state meaning as `ProductSummary.onHand`:
	 * `null` is "no inventory row for this sku (or no sku yet)" — UNKNOWN, never
	 * rendered as `0`; `0` is a known sku that is out of stock. A variant with no
	 * inventory row is ABSENT, never zero.
	 *
	 * An unknown product (or one that has declared no variants) returns `[]` —
	 * absence, never an error. That is the state the ENTIRE live catalog is in,
	 * and it is why nothing else in this port changes shape.
	 */
	listVariants(productId: ProductId): Promise<ProductVariantSummary[]>;

	/**
	 * The guarded ADMIN edit of a variant's commerce-owned fields — the exact
	 * mirror of `updateCommerceFields`, one level down, including its guard ORDER
	 * (contract-pinned on every adapter):
	 *  1. unknown `(productId, variantKey)`, or an ORPHANED row → `not_found`
	 *     FIRST, never a row minted: an edit is not a create, and it is not a
	 *     resurrection either (the way back is the CMS re-declaring the repeater
	 *     row, which is `upsertVariant`'s job — the same shape as a soft-deleted
	 *     product being unreachable from this surface).
	 *  2. a same-`key` replay against the live row → a no-op `ok` carrying the
	 *     stored row, AHEAD of the staleness check, so a double-submit dedupes
	 *     and a rename's units move exactly once.
	 *  3. `updatedAt` != `expectedUpdatedAt` → `stale` with the current row (the
	 *     optimistic compare-and-set; the port's lost-update guard).
	 *  4. a money-currency conflict → `currency_mismatch` with the current row.
	 *     Currency is an integrity axis at variant grain too, on TWO sub-axes:
	 *      a. a `price` whose currency differs from the VARIANT's stored price
	 *         currency (only once it has one — a first pricing is free); and
	 *      b. a `price` whose currency differs from the PRODUCT's currency — the
	 *         parent `product_commerce` row's price currency when it has one,
	 *         otherwise the currency of any other live priced variant of the same
	 *         product. A product whose sizes are priced in different currencies
	 *         has no honest total, no honest picker and no honest cart, so the
	 *         disagreement is refused at the write rather than rendered.
	 *  5. otherwise → applies the partial update (`undefined` PRESERVES; there is
	 *     no clear-to-null for either field), stamps `key`, bumps `updatedAt` —
	 *     and, when the update CHANGED the row's `sku`, carries that sku's
	 *     inventory row with it under THE SKU-RENAME RULE stated on this
	 *     interface, in this same transaction.
	 *
	 * THE SKU-RENAME RULE BINDS THIS WRITER UNCHANGED, because it is a property
	 * of the `sku` COLUMN rather than of one caller: refuse while the source sku
	 * has live holds, claim-or-refuse the target, carry the count, retain the
	 * source zeroed. `inventory` is keyed by the bare sku and knows nothing about
	 * products or variants, so a variant rename strands units exactly as a
	 * product rename did before the rule existed.
	 *
	 * A sku another LIVE sellable unit already holds throws `SkuConflictError` —
	 * "live sellable unit" spanning BOTH live variants (a partial unique index,
	 * mirroring `product_commerce`'s) and live `product_commerce` rows, INCLUDING
	 * this variant's own parent. One sku names one sellable unit: two names over
	 * one `inventory` row would let a later rename of either one carry the other's
	 * stock away. Moving a 1:1 product's sku DOWN onto its own first variant is
	 * therefore not expressible here — it is a two-row movement and needs its own
	 * transactional verb.
	 *
	 * NEVER writes `title` (CMS-owned — `adr/0016`), `variantKey` (the identity;
	 * the input names it as the TARGET and there is no field to change it with, so
	 * a re-key does not compile), or `orphanedAt` (the CMS presence axis).
	 */
	updateVariantFields(
		input: UpdateProductVariantFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductVariantUpdateResult>;

	/**
	 * The ORPHAN transition: the CMS repeater row that declared this variant is
	 * gone, so the variant stops being sellable — but the row is RETAINED, with
	 * its sku, its price and its inventory. DEACTIVATION, NEVER DELETION: an
	 * orphaned variant may still hold stock and still sit on live order lines, so
	 * deleting it would strand the units and dangle the history, which is the same
	 * class of loss THE SKU-RENAME RULE exists to prevent.
	 *
	 * `contentUpdatedAt` is the CMS content's own `updatedAt` for the save that
	 * dropped the row, and it shares ONE watermark with `upsertVariant` — unlike
	 * the product's publish gate, which needs a watermark of its own. The reason
	 * is that presence and title arrive on the SAME event: every save either
	 * re-declares a key (an upsert) or does not (a deactivate), so one watermark
	 * orders both transitions correctly and a second could only drift from it. A
	 * strictly older watermark is a no-op, so a delayed "the row is gone" can
	 * never orphan a variant a newer save has since re-declared.
	 *  - unknown `(productId, variantKey)` → no-op (no row minted).
	 *  - a same-`key` replay → no-op, unconditionally and AHEAD of every other
	 *    guard, exactly as the two write paths dedupe. Without it a redelivered
	 *    orphan whose row has since come back would apply a second time.
	 *  - already-orphaned → no-op (stable under replay), watermark untouched.
	 *  - a STALE watermark → no-op.
	 *  - otherwise → `orphanedAt` set to the store clock, the watermark advanced,
	 *    and `key` stamped as the row's last-applied replay key.
	 * The watermark comparison here is `<=` rather than the resurrect's strict
	 * `<`, and the asymmetry is deliberate: one save legitimately declares some
	 * keys and drops others at the SAME watermark, so an orphan must apply at a
	 * watermark equal to the one a previous save left behind — while a resurrect
	 * at an equal watermark would be re-litigating a decision already made (see
	 * `upsertVariant`).
	 *
	 * An orphaned variant's sku is FREED for reuse (the live-sku uniqueness index
	 * is partial, `WHERE orphaned_at IS NULL`) — exactly like a soft-deleted
	 * product's, and for the same reason: the tombstone keeps the history without
	 * locking the identifier forever.
	 */
	deactivateVariant(
		productId: ProductId,
		variantKey: string,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void>;
}

// -- Variants: one commerce row per sellable unit ----------------------------
//
// Stock and price are SKU-LEVEL facts by construction, so a size that can be
// bought separately is a ROW, not a decoration on the product row. The commerce
// row keys on the product PLUS a stable variant key; nothing about the product
// row changes, and a product that declares no variants has no variant rows and
// behaves exactly as it always did.

/**
 * One sellable unit of a product — the stored row, as read back from a store.
 *
 * IDENTITY IS `(productId, variantKey)`, and `variantKey` IS IMMUTABLE. It is
 * the CMS repeater row's own stable key, it is the primary key here, it appears
 * in no `SET` clause in any adapter, and neither write input carries a field
 * that could change it — so a re-key is unrepresentable rather than merely
 * discouraged. A key that mutates in the CMS therefore looks to this store like
 * a NEW variant plus a DROPPED one. THAT IS THE DESIGNED OUTCOME, not a gap: the
 * CMS cannot express a save-time refusal of a re-key, so the guarantee is on the
 * recovery side instead — the dropped row is orphaned rather than deleted and
 * keeps its sku, price and stock, and re-declaring the original key resurrects
 * it (on a strictly newer watermark). See `adr/0016-variant-title-is-cms-owned.md`,
 * "Amendment 2026-08-09".
 */
export interface ProductVariant {
	productId: ProductId;
	/** The CMS repeater row's stable, immutable key — the variant's identity
	 *  within its product. Opaque text; the store never parses or orders on its
	 *  structure beyond plain text comparison. */
	variantKey: string;
	/**
	 * This variant's own stock-keeping unit — the sku a cart line, a reservation
	 * and an order line all name. Null until an admin sets one ("declare then
	 * price": the CMS declares the variant, the admin prices it). Admin-owned:
	 * written ONLY by `updateVariantFields`, under THE SKU-RENAME RULE, and no
	 * writer can CLEAR it — there is no "unsku" edit.
	 *
	 * ONE EXCEPTION, and it is not an edit: a RESURRECT clears it when the sku was
	 * taken by another live sellable unit while this variant was orphaned (see
	 * `ProductCommerceStore.upsertVariant`). The row is not being edited there; it
	 * is losing a claim it no longer has.
	 */
	sku: Sku | null;
	/**
	 * This variant's own price — integer minor units plus an explicit currency,
	 * never a float. Null means ABSENT, which is a different fact from zero and
	 * must never be rendered as `0`, `0.00` or "Free"; the console's rule for an
	 * absent money value is an em dash. Admin-owned, like `sku`.
	 */
	price: Money | null;
	/**
	 * The variant's display name — a DERIVED CACHE of the CMS repeater row's name
	 * sub-field, with a SINGLE writer: `upsertVariant` (see
	 * {@link UpsertProductVariantInput} and `adr/0016-variant-title-is-cms-owned
	 * .md`). ADR-0013 applied one level down, clause for clause: the name is
	 * customer-facing content the CMS owns and translates, and this column exists
	 * so an ORDER LINE can snapshot the size a buyer actually bought without a
	 * cross-database read.
	 *
	 * Null until the first sync carries one, and eventually consistent — a failed
	 * sync leaves it stale until the next save of that document.
	 */
	title: string | null;
	/**
	 * The ORPHAN tombstone: non-null once the CMS stopped declaring this key, null
	 * while the variant is live. A distinct state from "absent" — the row, its
	 * sku, its price and its stock are all retained — and the state a console must
	 * render distinctly rather than hide, because an orphan may still hold units
	 * and still sit on live orders. Set by `deactivateVariant`, cleared by
	 * `upsertVariant` when the CMS declares the key again — which REVALIDATES the
	 * sku and price on the way back in rather than asserting them (see that
	 * method: an orphan's sku is free for reuse, so it may no longer be there to
	 * reclaim).
	 */
	orphanedAt: Date | null;
	/** Per-row "last applied" replay key — compare-on-write, exactly like
	 *  `ProductCommerce.idempotencyKey`, NOT a global UNIQUE constraint. */
	idempotencyKey: IdempotencyKey;
	/** The ONE ordering watermark for BOTH presence transitions (upsert and
	 *  deactivate) — the CMS content's own `updatedAt`, ISO-8601 text, so
	 *  lexicographic comparison IS chronological. Null until a sync carries one.
	 *  See `ProductCommerceStore.deactivateVariant` for why one watermark is
	 *  correct here where the product's publish gate needed a second. */
	contentUpdatedAt: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * `listVariants`'s row: the stored variant, NARROWED, plus the stock the same
 * statement joined for it.
 *
 * `idempotencyKey` and `contentUpdatedAt` are deliberately DROPPED. Both are
 * internal write-path bookkeeping — a per-row replay marker and a sync-ordering
 * watermark — and neither is a fact about the variant that any reader needs:
 * projecting them onto a list invites a caller to branch on machinery it does
 * not own, and puts a value the CMS controls onto a wire it has no business
 * reaching. `updatedAt` STAYS, because it is the compare-and-set watermark an
 * editor must pass back to `updateVariantFields` — the one piece of write-path
 * state a reader legitimately needs. A caller that genuinely needs the dropped
 * two is holding the full `ProductVariant` a write returned.
 */
export interface ProductVariantSummary extends Omit<
	ProductVariant,
	"idempotencyKey" | "contentUpdatedAt"
> {
	/**
	 * Stock on hand for this variant's sku — a COUNT, never money.
	 *
	 * THREE STATES, never two: `null` is "no inventory row for this sku, or no
	 * sku yet" (UNKNOWN — a variant with no inventory row is ABSENT, never 0),
	 * and `0` is a known sku that is out of stock. Sourced by the same LEFT JOIN
	 * onto `inventory` that `ProductSummary.onHand` uses, in the same statement
	 * as the page — the join miss IS the null.
	 */
	onHand: number | null;
}

/**
 * The CMS-sync input for one variant — the ONLY channel that may write
 * `ProductVariant.title`.
 *
 * ADR-0013 ONE LEVEL DOWN, CLAUSE FOR CLAUSE (`adr/0016-variant-title-is-cms-
 * owned.md`). The CMS repeater row owns the variant's identity and its display
 * name and carries NOTHING COMMERCIAL; the commerce row owns the sku, the price
 * and the stock. So this input deliberately EXCLUDES:
 *  - `sku` and `price` — commerce-owned, edited through
 *    {@link UpdateProductVariantFieldsInput} under a compare-and-set. A sync that
 *    could write them would be a second writer racing the admin, which is the
 *    exact failure the product-level decision removed.
 *  - `orphanedAt` — the presence axis is a TRANSITION (`deactivateVariant`), not
 *    a field, for the same reason `active` is not a field on
 *    `UpsertProductCommerceInput`.
 * And the admin edit correspondingly has no `title`, so neither writer can reach
 * the other's column and the two can never disagree.
 *
 * `variantKey` is the IDENTITY, not an editable field: supplying a different one
 * addresses a DIFFERENT variant (creating it if unknown) and leaves the first
 * exactly as it was — it is never a rename.
 */
export interface UpsertProductVariantInput {
	productId: ProductId;
	variantKey: string;
	/** The CMS repeater row's display name. `undefined` PRESERVES the stored
	 *  cache, an explicit `null` CLEARS it (a collection whose name sub-field is
	 *  empty), exactly like `UpsertProductCommerceInput.title`. */
	title?: string | null;
	/** The CMS content's own `updatedAt` — the ordering watermark shared with
	 *  `deactivateVariant` (see `ProductVariant.contentUpdatedAt`). A strictly
	 *  older value than the stored watermark makes this upsert a no-op. */
	contentUpdatedAt?: string;
}

/**
 * The commerce fields an admin may edit on ONE variant — a strict mirror of
 * `UpdateProductCommerceFieldsInput`, one level down. Deliberately EXCLUDES:
 *  - `title` — CMS-OWNED (`adr/0016`), for exactly the reason
 *    `UpdateProductCommerceFieldsInput` excludes the product's. The console
 *    renders the variant name as READ-ONLY text, never an input.
 *  - `variantKey` as anything but the TARGET — the key is the identity and is
 *    immutable, so there is no field here to change it with and a re-key does
 *    not compile.
 *  - `orphanedAt` — the CMS presence axis, moved by `deactivateVariant` /
 *    `upsertVariant`, never by a merchant edit.
 * Partial-update grain matches its product-level sibling: `undefined` PRESERVES
 * the stored value. Neither field can be cleared back to null once set (there is
 * no "unsku" and no "unprice" case in scope). A raw `number` price is a compile
 * error — `price.amount` is branded `Cents`.
 */
export interface UpdateProductVariantFieldsInput {
	productId: ProductId;
	variantKey: string;
	/** Supplying a DIFFERENT value than the row holds is a RENAME, and a rename
	 *  carries this variant's on-hand count onto the new sku in the SAME
	 *  transaction — or refuses (THE SKU-RENAME RULE on `ProductCommerceStore`,
	 *  which binds this writer exactly as it binds the two product-level ones). */
	sku?: Sku;
	price?: Money;
}

/**
 * Outcome of a guarded variant edit — the same discriminated union shape as
 * `ProductCommerceUpdateResult`, so a console renders both without
 * status-code-as-logic. `not_found` covers an unknown key AND an orphaned row
 * (an edit is neither a create nor a resurrection); `stale` and
 * `currency_mismatch` carry the fresh row to reload from.
 */
export type ProductVariantUpdateResult =
	| { ok: true; variant: ProductVariant }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; current: ProductVariant }
	| { ok: false; reason: "currency_mismatch"; current: ProductVariant };
