---
"@otta-sh/domain": minor
---

Phase 1 — product model + sync (domain slice).

- `@otta-sh/domain`: add the `ProductCommerceStore` port (`upsert`/`getByProductId`/
  `softDelete`), branded `UpsertProductCommerceInput`/`ProductCommerce` (money as
  `Cents` + `Currency`, never a raw number), the `MissingProductIdError` "create
  then price" guard, an in-memory fake, and the reusable
  `productCommerceStoreContract`. `InventoryStore` additively grows
  `seedOnHand(sku, qty)` — a create-if-absent initial-stock write that can never
  clobber a concurrent reserve/release, with its own contract cases.
- Review round 1: the `seedOnHand` seed is attempted on EVERY save carrying a
  stock figure (create-if-absent makes it a no-op once the row exists), so a
  partial failure after the product upsert can no longer permanently strand a
  priced product without an inventory row — a retried save heals it. The
  upsert is order-aware: it stores a `content_updated_at` watermark (the CMS
  content's own `updatedAt`, sent by sync upserts) and a strictly-older sync
  is a stale no-op, so out-of-order hook delivery converges; panel saves omit
  the watermark (last-writer-wins, documented + pinned). `sku` uniqueness is
  now scoped to LIVE rows, so a soft-deleted product's SKU is reusable by a
  new product while two live products still cannot share one — pinned by the
  store contract and mirrored by the in-memory fake. A live-SKU conflict is
  the structured domain `SkuConflictError` carrying the offending `sku`, never
  an opaque store failure. The sync-ordering watermark is strictly validated
  at the boundary as `Date.toISOString()`-format UTC (it feeds a raw
  lexicographic comparison; one garbage high-sorting value stored once would
  make every future legitimate sync stale forever) — anything else is refused.
