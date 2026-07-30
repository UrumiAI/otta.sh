---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Syncs a product's commerce purchasability to its CMS publish lifecycle in both directions: publishing a product in EmDash makes it purchasable on the storefront, and unpublishing it makes it non-purchasable again (previously `active` was a one-way latch — an unpublished product stayed purchasable on a direct product-page hit). The publish and unpublish syncs are independent fire-and-forget calls, so they carry an ordering watermark (the content's `updatedAt`) and converge under out-of-order delivery: a delayed, stale publish can never re-latch a product an unpublish has since made non-purchasable, matching the convergence the content-save path already guarantees.

- `@otta-sh/domain`: adds `ProductCommerceStore.activate` / `deactivate` port methods and the `activateProductCommerce` / `deactivateProductCommerce` use-cases — flips of the `active` publish gate, kept separate from `upsert` (which never touches `active`/`deletedAt`). Each carries a `contentUpdatedAt` ordering watermark; unknown, already-in-that-state, soft-deleted, and stale (out-of-order) calls are stable no-ops, and neither publish nor unpublish ever resurrects or re-stamps a soft-deleted product.
- `@otta-sh/store-postgres`: implements `activate` and `deactivate` as single guarded `UPDATE`s (`deleted_at IS NULL`, the state guard, and a dedicated `active_updated_at` watermark guard) on Postgres and SQLite.
- `@otta-sh/service`: adds `POST /products/:id/commerce/activate` and `POST /products/:id/commerce/deactivate` (`Idempotency-Key` header required; the request body carries the `contentUpdatedAt` watermark), dedicated action routes mirroring the port.
- `@otta-sh/plugin`: registers the `content:afterPublish` and `content:afterUnpublish` hooks and calls the matching service endpoints with lifecycle-derived idempotency keys and the content's `updatedAt` watermark, so a product's storefront purchasability follows its CMS publish state and converges even if the hook deliveries arrive out of order.
