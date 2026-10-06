---
"@otta-sh/plugin": minor
---

`entitlements/download` now answers the file to serve (issue #376, increment 2). On
success it returns `{ authorized: true, sku, asset }`, where `asset` is the product's
`{ key, filename, contentType, size, sha256? }`. The site uses it to stream the bytes from
its private bucket in increment 3.

It answers only when the whole delivery gate holds, read fresh on every call:

- the entitlement for this order and sku is active;
- the order is `paid`, `processing`, `shipped`, `delivered` or `completed`. A `refunded`,
  `cancelled`, `expired`, `failed` or `pending` order never delivers, whatever its grant
  says. This covers a revocation that never ran (a crash with no retry), and a grant that
  landed after a refund;
- the product is `digital` now, so a product flipped to physical with its file still
  attached is never served;
- the stored descriptor passes `validateDownloadAsset` for this product, so its key is
  `dl/{productId}/…`.

Every refusal that depends on stored data is the same answer, `{ authorized: false,
reason: "NOT_FOUND" }`, so the route cannot be used to learn which orders exist. A
malformed `orderId` or `sku` (missing, empty, over 200 characters, or containing U+0000) is
`INVALID_INPUT` and is decided before any read. `BUSY` is unchanged.

The route stays public, because the site's in-process dispatcher reaches public routes
only. Returning the bucket key there is deliberate: the key opens nothing on its own, since
the bucket is private and the site never takes a key from its caller. The route's doc
comment gives the full reasoning.

**BREAKING for callers of `entitlements/download`** (there are none in this repo yet):

- `orderId` is required. A session-only request is now `INVALID_INPUT`, because delivery is
  per order.
- A `sessionToken` sent alongside an `orderId` is ignored, as ADR-0011 rules. The old
  fallback is gone: it checked the session's own entitlements when the order had none, so
  one buyer's session could authorize a download on another buyer's order id.
- `NOT_ENTITLED` and `UNAUTHENTICATED` are replaced by `NOT_FOUND`.
