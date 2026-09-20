---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Add the admin Coupons console's missing enumerate primitive — a VIEW-ONLY,
keyset-paginated coupon list (admin-UX Increment 3, "coupon enumerate + coupon
list"), mirroring `ProductCommerceStore.listProducts`'s proven shape 1:1. No
coupon editing/creation UI, no new coupon fields — both are separate slices.

- `@otta-sh/domain`: adds `CouponStore.listCoupons(filter, page)` returning a
  keyset-paginated `CouponSummary` projection, ordered `created_at DESC, id
  DESC` (the only sort this slice offers). `coupons` had NO `created_at`
  column before this slice — `create()` now stamps one from the injected
  `Clock` (`InMemoryCouponStore` and every `CouponStore` adapter gain a
  required `clock` constructor option). `CouponListFilter` is deliberately
  minimal:
  `search`, a case-insensitive EXACT match on `code` (the strictest `search` in
  the product — a coupon code is a structured identifier, not free text like a
  product title, so there is no substring half, and it did not follow the later
  widening of `OrderListFilter.search` in this release either). `CouponSummary`
  mirrors `CouponRecord` field-for-field plus
  `createdAt` — a small, header-only table has nothing expensive to trim off
  the list (unlike `ProductSummary`'s narrower projection). `usesCount`
  (already a plain stored column) doubles as the cheap "has this been
  redeemed" indicator — no correlated `EXISTS` on `coupon_redemptions`, no
  N+1. The `InMemoryCouponStore` fake and the shared `couponStoreContract`
  pin the spec (empty, projection, ordering, identical-`created_at`
  tie-break, exact-code search, pagination no-overlap/no-gap, limit
  boundary).
- `@otta-sh/plugin`: the admin rules client gains `listCoupons(filter, opts)`
  (client method only — the admin UI screen is a follow-up slice), returning
  the `CouponSummaryWire` projection + an opaque `nextCursor`. The cursor keeps
  the same base64url discipline as the admin products list: a malformed or
  tampered cursor fails CLOSED and the decoded limit is re-clamped, never
  trusted past 100.
