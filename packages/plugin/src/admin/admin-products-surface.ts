/**
 * The admin Products console surface — the port the console pages hold, plus the
 * wire-shaped types that cross it. A read surface (list + detail) plus the
 * guarded commerce EDIT (`updateProduct`) and the merchant stock movements
 * (`restock` / `removeStock`). No product-CREATE method here — that stays in the
 * CMS sync path.
 *
 * These types are defined LOCALLY and deliberately: this module NEVER imports
 * `@otta-sh/domain`, which keeps the plugin sandbox-clean (enforced by the
 * dependency-cruiser rule, MOD-4). Money is integer minor units + ISO-4217
 * currency throughout. The "wire" in the names is historical — it was once the
 * JSON shape of a separate commerce service — and it is still exactly the shape
 * the admin route's JSON responses use, so the name stays accurate.
 */

/** A lightweight product row for the admin list. It DOES carry stock: the list
 *  read sources `onHand` in ONE batched pass per page, so it never N+1s into
 *  inventory per row (see {@link AdminProductsSurface.getProduct}'s doc for the
 *  detail leaf's separate single-sku read). */
export interface ProductSummaryWire {
	productId: string;
	sku: string | null;
	title: string | null;
	priceCents: number | null;
	currency: string | null;
	productKind: string;
	active: boolean;
	/** Stock on hand — a COUNT, never money (no minor units, no currency).
	 *
	 *  `null` means the sku has NO inventory record (or the product has no sku
	 *  at all): "unknown", which is NOT `0` ("out of stock"). A renderer must
	 *  keep the two apart — a dash for `null`, a literal `0` for zero — and
	 *  never fold either into the other. */
	onHand: number | null;
	/** Soft-delete tombstone (product lifecycle surfacing). Null on every row
	 *  of a default (live) page; non-null only in the archive view
	 *  (`ProductsListFilter.deleted: true`). */
	deletedAt: string | null;
	createdAt: string;
}

/** The full admin Product detail (read-only) — carries the single-sku stock
 *  read (`onHand`) the detail leaf fetches for the ONE product opened; the
 *  list gets the same field from its per-page join instead. */
export interface ProductDetailWire {
	productId: string;
	sku: string | null;
	title: string | null;
	priceCents: number | null;
	currency: string | null;
	taxClass: string | null;
	/** Increment 2 slice 5: compare-at / was-price (shares the product currency;
	 *  display-only). Both halves null ⇒ unset. */
	compareAtCents: number | null;
	compareAtCurrency: string | null;
	/** Increment 2 slice 5: ADMIN-ONLY unit cost (shares the product currency).
	 *  Present here because this is the internal-token admin detail — never on a
	 *  storefront wire. Both halves null ⇒ unset. */
	unitCostCents: number | null;
	unitCostCurrency: string | null;
	/** Increment 2 slice 5: out-of-stock policy (always `"deny"` this slice). */
	inventoryPolicy: string;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: string;
	active: boolean;
	/** Soft-delete tombstone (product lifecycle surfacing). Non-null ⇒ this IS
	 *  the read-only archive view — the detail leaf renders it instead of the
	 *  edit/stock forms (see `products-page.ts`'s `detailBlocks`). A 404 (never
	 *  existed) is still `getProduct` returning `null`; a deleted row is a 200
	 *  with this field set. */
	deletedAt: string | null;
	/** Stock on hand for this product's sku — a COUNT, never money.
	 *
	 *  SAME SEMANTICS AS THE LIST's `ProductSummaryWire.onHand` (INC-23): `null`
	 *  means the sku has NO inventory record (or the product has no sku at all)
	 *  — "unknown" — and `0` means a known sku that is out of stock. This used to
	 *  be a bare `number` with both cases collapsed to `0`, so one product read
	 *  `—` in the list and `0` on its own detail page. A renderer keeps the two
	 *  apart with the same helper the list column uses. */
	onHand: number | null;
	createdAt: string;
	updatedAt: string;
}

/** The list filter the console builds from its filter form. `active` is a
 *  tri-state string ("" ⇒ both) so the wire query mirrors the service's
 *  `active=true|false` param exactly. `deleted` is the archive-view toggle
 *  (product lifecycle surfacing): omitted/false ⇒ the original default (live
 *  rows only); true ⇒ ONLY soft-deleted rows. */
export interface ProductsListFilter {
	active?: boolean;
	deleted?: boolean;
	productKind?: string;
	search?: string;
	/** The store's low-stock threshold, when the console has resolved one AND
	 *  "Low stock only" is on — mirrors the domain port's `ProductListFilter.
	 *  lowStockThreshold` one field at a time, same as every other
	 *  axis here. OMITTED means "no stock-based filtering", not "threshold 0":
	 *  the caller (the console route) only sets this once a settings read has
	 *  actually resolved a number, never a raw checkbox state. */
	lowStockThreshold?: number;
}

export interface ProductsListResult {
	products: ProductSummaryWire[];
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
	/**
	 * Exact number of products matching the ACTIVE FILTER — the whole set, not
	 * this page (INC-23).
	 *
	 * OPTIONAL for one reason only: a service older than the field omits it, and
	 * a renderer must then fall back to the page-scoped count it always had
	 * ("25 products on this page"). Never defaulted to `0` — that would caption
	 * a page of rows with a count of none.
	 */
	total?: number;
	/**
	 * THIS IS PAGE ONE, because the cursor the caller asked with was REFUSED —
	 * mismatched against these filters, or undecodable — and
	 * {@link AdminProductsSurface.listProducts} re-issued without it. Absent on
	 * every ordinary page, first pages included: the flag means "you asked for a
	 * page you did not get", which the renderer has to be able to say out loud.
	 * Same contract, same reasoning, as the Orders client's.
	 */
	cursorRejected?: true;
}

/** The commerce-owned fields a product edit may change. The set is STRICT — an
 *  unknown key is refused as invalid, never silently stripped. `expectedUpdatedAt` is the optimistic-concurrency
 *  watermark the admin loaded; the service compare-and-sets on it. Money is an
 *  integer minor-units + ISO-4217 pair — never a float. NO `active` (the CMS
 *  publish gate is not edited here) and NO `title` (CMS-owned, written only by
 *  the content sync — `adr/0013-product-title-is-cms-owned.md`). */
export interface ProductEditWire {
	expectedUpdatedAt: string;
	sku?: string;
	price?: { amount: number; currency: string };
	taxClass?: string | null;
	/** Increment 2 slice 5: compare-at / cost — money (integer minor units +
	 *  ISO-4217), null to CLEAR. Must share the product's price currency (the
	 *  service/domain enforce it; a mismatch is a per-field error). */
	compareAtPrice?: { amount: number; currency: string } | null;
	unitCost?: { amount: number; currency: string } | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: string;
	/** Out-of-stock policy — only `"deny"` is accepted this slice. */
	inventoryPolicy?: string;
}

/** One tax-class registry entry (mirrors the domain `TaxClass`) — the edit
 *  form's tax-class select is sourced from these. */
export interface TaxClassWire {
	id: string;
	name: string;
}

/** Discriminated edit outcome — the plugin renders each without status-code-as-
 *  logic (stale → reload notice, currency/sku → per-field warning).
 *
 *  THE TWO RENAME REFUSALS ARE THEIR OWN MEMBERS, not one "sku problem". They
 *  ask the operator for different things — pick another sku, versus wait for
 *  the carts to finish — so folding them together would cost the only sentence
 *  that helps, and each carries the operands its sentence names. */
export type ProductEditResult =
	| { ok: true; updatedAt: string | null }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; currentUpdatedAt: string | null }
	| { ok: false; reason: "currency_mismatch"; currency: string | null }
	| { ok: false; reason: "sku_taken"; sku: string | null }
	/** The rename's target sku already has an inventory row of its own; stock is
	 *  never merged between skus, so the rename was refused whole. */
	| { ok: false; reason: "sku_stock_conflict"; fromSku: string | null; toSku: string | null }
	/** Live held/adopted reservations still name the sku being renamed away
	 *  from. `liveHolds` is `null` only if the service omitted the count. */
	| { ok: false; reason: "sku_held_stock"; sku: string | null; liveHolds: number | null }
	| { ok: false; reason: "invalid"; field: string | null }
	| { ok: false; reason: "error" };

/** Discriminated restock outcome (admin-UX Increment 2 slice 3). `not_found`/
 *  `no_sku`/`no_inventory_row` are the productId → sku resolution failures; the
 *  panel renders each without treating a status code as logic. */
export type RestockResult =
	| { ok: true; onHand: number }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "no_sku" }
	| { ok: false; reason: "no_inventory_row" }
	| { ok: false; reason: "invalid" }
	| { ok: false; reason: "error" };

/** Discriminated stock-removal outcome (admin-UX Increment 2 slice 3). Adds
 *  `insufficient_stock` (carrying the current count) — the guarded floor that
 *  keeps a removal from ever driving on-hand below zero. */
export type StockRemovalResult =
	| { ok: true; onHand: number }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "no_sku" }
	| { ok: false; reason: "no_inventory_row" }
	| { ok: false; reason: "insufficient_stock"; onHand: number }
	| { ok: false; reason: "invalid" }
	| { ok: false; reason: "error" };

/**
 * THE ADMIN PRODUCTS SURFACE, structurally — what a caller may do, with no claim
 * about how it gets done.
 *
 * ONE implementation answers to this now (work order 02, INC-D3b):
 * `InProcessAdminProductsClient`, which composes this behaviour over the
 * plugin's own document store. The `ctx.http` client that used to be the second
 * implementation is gone with the commerce service it talked to, and with it the
 * reason this was a `Pick` over a nominal class rather than an interface — so it
 * is written out as an interface now, which is what it always described.
 *
 * EVERY METHOD IS LISTED, and writing them out is still the point: a method
 * added to the in-process client without being declared here is not part of the
 * surface, and a method declared here that the client does not implement is a
 * compile error. The surface stays a deliberate decision rather than whatever
 * one class happens to expose.
 */
export interface AdminProductsSurface {
	/**
	 * Update the commerce-owned fields of one product (admin-UX Increment 2 slice
	 * 2). `key` is the stable idempotency key (a double-submit dedupes). Every
	 * failure mode is a named `reason` on the result, so the caller never
	 * inspects a status code and never has to guess which sentence to show.
	 */
	updateProduct(productId: string, body: ProductEditWire, key: string): Promise<ProductEditResult>;

	/**
	 * RESTOCK — ADD `qty` units to the product's stock (admin-UX Increment 2 slice
	 * 3). `key` is REQUIRED and must be stable per submission: a restock is
	 * additive (not idempotent by nature), so there is no safe content-only
	 * fallback — a double-submit dedupes only when the SAME key is sent.
	 */
	restock(productId: string, qty: number, key: string): Promise<RestockResult>;

	/**
	 * STOCK REMOVAL — remove `qty` damaged/shrinkage units (admin-UX Increment 2
	 * slice 3). Same required-key discipline as {@link restock}. The decrement is
	 * GUARDED, so an over-removal is a clean `insufficient_stock` (carrying the
	 * current count), never a negative stock or a throw.
	 */
	removeStock(productId: string, qty: number, key: string): Promise<StockRemovalResult>;

	/**
	 * THE FILTER TRAVELS BESIDE THE CURSOR, and it did not used to — the same
	 * correction, for the same reason, as {@link AdminOrdersSurface.listOrders},
	 * whose doc carries the argument in full. In short: the reader used to take
	 * the predicate solely from the token and never look at the filter passed
	 * alongside it, so an unfiltered token sent beside a low-stock threshold
	 * answered with the unfiltered catalog and a console captioned those rows
	 * "low-stock". The two are now compared as predicates and a disagreement
	 * refuses the cursor, which is only useful if the call states both.
	 *
	 * EVERY AXIS PARTICIPATES, the threshold included — `0` is a real threshold
	 * and is compared as one, never read as "absent". So a paged low-stock call
	 * must carry the threshold page one was filtered by; the console route
	 * resolves it before paging for exactly that reason.
	 *
	 * NO CASE FOLDING before the store: the comparison is case-sensitive by
	 * design, and a caller that normalised a search term on one call but not the
	 * other would manufacture mismatches.
	 *
	 * A REFUSED CURSOR IS RECOVERED HERE, not reported — page one is re-read with
	 * the same filter and flagged `cursorRejected`. See the Orders doc for why the
	 * flag matters as much as the rows.
	 */
	listProducts(
		filter: ProductsListFilter,
		opts?: { cursor?: string; limit?: number },
	): Promise<ProductsListResult>;

	/** Read one product's full detail (incl. stock). A product that does not
	 *  exist resolves to `null` (the console renders a "not found" state, not an
	 *  error banner); a soft-deleted one is a real row with `deletedAt` set. */
	getProduct(productId: string): Promise<ProductDetailWire | null>;

	/**
	 * Read the tax-class registry (Increment 2 slice 5) — the source for the edit
	 * form's tax-class select. A SECONDARY, best-effort read: the caller wraps it
	 * in try/catch and falls back to a static default set, so a registry read
	 * failure degrades the select (fewer options) rather than failing the whole
	 * product detail.
	 */
	getTaxClasses(): Promise<TaxClassWire[]>;
}
