---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
---

Phase 1 — product model + sync (domain/adapter/service slice).

- `@otta-sh/domain`: add the `ProductCommerceStore` port (`upsert`/`getByProductId`/
  `softDelete`), branded `UpsertProductCommerceInput`/`ProductCommerce` (money as
  `Cents` + `Currency`, never a raw number), the `MissingProductIdError` "create
  then price" guard, an in-memory fake, and the reusable
  `productCommerceStoreContract`. `InventoryStore` additively grows
  `seedOnHand(sku, qty)` — a create-if-absent initial-stock write
  (`ON CONFLICT (sku) DO NOTHING`) that can never clobber a concurrent
  reserve/release, with its own contract cases on every dialect.
- `@otta-sh/store-postgres`: a forward-only `0002_product_commerce` migration and
  `KyselyProductCommerceStore` — a single conditional
  `INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE idempotency_key != :key`
  implementing per-row compare-on-write replay dedupe (distinct from Phase 0's
  globally-unique `reservations.idempotency_key`), plus `seedOnHand` on
  `KyselyInventoryStore`.
- `@otta-sh/service`: `PUT`/`GET`/`DELETE /products/:id/commerce`, a 1:1
  serialization of the port (`Idempotency-Key` header, zod-validated body, money
  on the wire as integer + ISO-4217 string, `MISSING_PRODUCT_ID` → 400), wired to
  seed initial `on_hand` via the create-if-absent `seedOnHand`.
- Review round 1: the `seedOnHand` seed is attempted on EVERY save carrying a
  stock figure (create-if-absent makes it a no-op once the row exists), so a
  partial failure after the product upsert can no longer permanently strand a
  priced product without an inventory row — a retried save heals it. The
  upsert is order-aware: it stores a `content_updated_at` watermark (the CMS
  content's own `updatedAt`, sent by sync upserts) and a strictly-older sync
  is a stale no-op, so out-of-order hook delivery converges; panel saves omit
  the watermark (last-writer-wins, documented + pinned). `sku` uniqueness is
  now a PARTIAL unique index over live rows (`WHERE deleted_at IS NULL`), so
  a soft-deleted product's SKU is reusable by a new product while two live
  products still cannot share one — enforced identically on Postgres and
  SQLite and mirrored by the in-memory fake. A live-SKU conflict is the
  structured domain `SkuConflictError` (caught narrowly on the partial-index
  violation in the Kysely store, thrown directly by the fake) and maps to
  HTTP 409 `{ok:false, error:"SKU_TAKEN", sku}` at the service — never an
  opaque 500. The sync-ordering watermark is strictly validated at the wire
  boundary as `Date.toISOString()`-format UTC (it feeds a raw lexicographic
  SQL comparison; one garbage high-sorting value stored once would make
  every future legitimate sync stale forever) — anything else is a 400.
