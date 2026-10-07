---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Add the admin Products console's missing enumerate primitive — a WooCommerce-style
VIEW-ONLY product list + read-only detail (admin-UX Increment 2, "product enumerate
+ product list"). No product editing, no restock — both are later increments.

- `@otta-sh/domain`: adds `ProductCommerceStore.listProducts(filter, page)` returning
  a lightweight, keyset-paginated `ProductSummary` PROJECTION (never joined with
  `inventory` — the list must not N+1 into stock per row). Ordering is
  `created_at DESC, product_id DESC` — the only sort this slice offers; `title`
  would be the natural catalog-browsing alternative, but it's nullable
  ("create then price") and a nullable-column keyset needs NULLS-LAST handling
  that isn't "sortable where cheap" yet, so it's deferred. `ProductListFilter` is
  `active`/`productKind` (single-value equality — a product's publish gate and kind
  are each two-value axes, unlike `OrderListFilter.states`'s OR-set) plus `search`,
  which DELIBERATELY DIVERGES from `OrderListFilter.search` as it stood here:
  a case-insensitive SUBSTRING match on `title` (free text a merchant partially
  remembers) OR an exact match on `sku` (a structured identifier). Orders' own
  search is widened later in this release, converging on the title half and
  leaving `sku` as the one axis that stays exact. Always excludes soft-deleted
  rows. Also adds `InventoryStore.getOnHand(sku)` — a bare, read-only single-sku
  stock lookup (a sku with no row reads as `0`) so the product detail leaf can
  show stock without a store-side join or N+1. The `InMemoryProductCommerceStore`/
  `InMemoryInventoryStore` fakes and the contract suites pin both specs (empty,
  filters, pagination no-overlap/no-gap, identical-`created_at` tie-break, limit
  boundary, tombstone exclusion).
- `@otta-sh/plugin`: adds the Products admin page (list with an active/kind/search
  filter form, keyset "Load more", columns title/SKU/price/status/kind — stock
  deliberately OMITTED from the list; open-product → read-only detail showing the
  full product fields incl. stock, via the single-sku `onHand` read). The list
  cursor is OPAQUE and embeds the active filter, mirroring the Orders console's
  cursor discipline — a malformed or tampered cursor fails CLOSED and the decoded
  limit is re-clamped. An unknown OR soft-deleted product reads as not-found;
  there is no admin surface for browsing or restoring a tombstone yet. The plugin
  defines its own local wire types and never imports `@otta-sh/domain`
  (sandbox-clean). The staging trusted descriptor registers the new page.
