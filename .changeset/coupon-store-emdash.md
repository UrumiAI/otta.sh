---
"@otta-sh/store-emdash": minor
---

Add `EmdashCouponStore`: the whole `CouponStore` port over the plugin-storage
primitives, with no over-redeem and no transaction.

The guarded `uses_count + 1 WHERE max_uses IS NULL OR uses_count < max_uses`
splits into two branches — a guarded `updateIf` that is a compare-and-set on both
the cap and a once-only witness when the coupon is capped, and a plain delta when
it is not. The per-key replay record is a document whose id IS the
`(couponId, idempotencyKey)` pair, so create-if-absent is the once-only guard, and
the recorded outcome answers a replay for a refusal as much as for a success. The
per-customer cap is claimed BEFORE the global counter and given back by an
idempotent compensation if the counter refuses, so a per-customer rejection never
consumes global headroom and a global refusal never leaves a per-customer count
consumed.

The coupon's code is a claim document, which is both the uniqueness rule and how
`findByCode` and the admin list's case-insensitive exact search reach a coupon —
one document read, never a scan.
