---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
---

Phase 1 — product model + sync (domain/adapter/service slice).

- `@urumi/domain`: add the `ProductCommerceStore` port (`upsert`/`getByProductId`/
  `softDelete`), branded `UpsertProductCommerceInput`/`ProductCommerce` (money as
  `Cents` + `Currency`, never a raw number), the `MissingProductIdError` "create
  then price" guard, an in-memory fake, and the reusable
  `productCommerceStoreContract`. `InventoryStore` additively grows
  `seedOnHand(sku, qty)` — a create-if-absent initial-stock write
  (`ON CONFLICT (sku) DO NOTHING`) that can never clobber a concurrent
  reserve/release, with its own contract cases on every dialect.
- `@urumi/store-postgres`: a forward-only `0002_product_commerce` migration and
  `KyselyProductCommerceStore` — a single conditional
  `INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE idempotency_key != :key`
  implementing per-row compare-on-write replay dedupe (distinct from Phase 0's
  globally-unique `reservations.idempotency_key`), plus `seedOnHand` on
  `KyselyInventoryStore`.
- `@urumi/service`: `PUT`/`GET`/`DELETE /products/:id/commerce`, a 1:1
  serialization of the port (`Idempotency-Key` header, zod-validated body, money
  on the wire as integer + ISO-4217 string, `MISSING_PRODUCT_ID` → 400), wired to
  seed initial `on_hand` on first creation of a priced row.
