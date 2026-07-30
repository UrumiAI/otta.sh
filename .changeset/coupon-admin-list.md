---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
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
  `Clock` (`KyselyCouponStore`/`InMemoryCouponStore` both gain a required
  `clock` constructor option). `CouponListFilter` is deliberately minimal:
  `search`, a case-insensitive EXACT match on `code` (mirrors
  `OrderListFilter.search`'s exact-only semantics — a coupon code is a
  structured identifier, not free text like a product title, so there is no
  substring half). `CouponSummary` mirrors `CouponRecord` field-for-field plus
  `createdAt` — a small, header-only table has nothing expensive to trim off
  the list (unlike `ProductSummary`'s narrower projection). `usesCount`
  (already a plain stored column) doubles as the cheap "has this been
  redeemed" indicator — no correlated `EXISTS` on `coupon_redemptions`, no
  N+1. The `InMemoryCouponStore` fake and the shared `couponStoreContract`
  pin the spec (empty, projection, ordering, identical-`created_at`
  tie-break, exact-code search, pagination no-overlap/no-gap, limit
  boundary).
- `@otta-sh/store-postgres`: migration `0018_coupons_admin_list` adds
  `coupons.created_at` (`NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'` — a
  sentinel, not nullable, so a pre-migration row sorts deterministically to
  the end of the DESC keyset on BOTH dialects; pg and better-sqlite3 order
  NULLs oppositely in DESC, which a nullable sort-key column would have
  exposed) plus a composite `(created_at, id)` index, mirroring `0015`'s
  precedent for `listProducts`. `listCoupons` is a single `coupons` SELECT —
  no join.
- `@otta-sh/service`: adds the internal-token-guarded `GET /admin/coupons`
  (mounted alongside the existing coupon CRUD in `rules-admin.ts`) with the
  same opaque base64url keyset cursor discipline as `GET /admin/products` — a
  malformed/tampered cursor fails CLOSED to 400 and the decoded limit is
  re-clamped, never trusted past 100.
- `@otta-sh/plugin`: adds `AdminRulesClient.listCoupons(filter, opts)` (client
  method only — the admin UI screen is a follow-up slice), returning the
  `CouponSummaryWire` projection + an opaque `nextCursor`.
