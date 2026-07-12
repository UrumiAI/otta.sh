---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
---

Removes the per-cart-line N+1 product-snapshot read in both checkout paths by adding a single bulk store method and rewiring both callers to fetch once. Snapshot semantics are unchanged: an order line still snapshots price + title at purchase time, and every per-line null / price / currency / kind check is byte-for-byte identical.

- `@urumi/domain`: adds `ProductCommerceStore.getManyByProductId(productIds)`, the bulk companion to `getByProductId` — a raw row read returning the FULL `ProductCommerce` (title / taxClass / productKind included, unlike the narrower `listCommerceByIds` view) keyed by id in a `Map`. It applies no `deleted_at` / sku / price guards (the callers do their own per-line checks); missing ids are absent from the Map, duplicate input ids collapse, and there is no ordering guarantee. `createOrderFromCart` now fetches every priced line's projection in one call instead of one `getByProductId` per line.
- `@urumi/store-postgres`: implements `getManyByProductId` as one `SELECT … WHERE product_id IN (:ids)` (no inventory join, no commerce-complete guards) on Postgres and SQLite; the empty id list short-circuits without touching the DB. Pinned by a store-level query-count test asserting exactly one statement for N ids.
- `@urumi/service`: `POST /checkout/quote` fetches every line's snapshot via one `getManyByProductId` before the loop instead of a per-line read, preserving its existing checks (including the deliberate absence of a `title === null` check).
