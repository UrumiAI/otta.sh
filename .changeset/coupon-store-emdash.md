---
"@otta-sh/store-emdash": minor
---

Add `EmdashCouponStore`: the whole `CouponStore` port over the plugin-storage
primitives, with no over-redeem and no transaction.

The guarded `uses_count + 1 WHERE max_uses IS NULL OR uses_count < max_uses`
splits into two branches — a guarded `updateIf` when the coupon is capped, a plain
delta when it is not — and the guard carries the cap and nothing else, so
redemptions of one coupon never contend until the cap actually binds. Once-only
lives in the per-key document instead: its id IS the
`(couponId, idempotencyKey)` pair, so create-if-absent claims it, and moving it
from `claimed` to `bumping` is a revision compare-and-set that exactly one
completer wins under a lease — so of N callers retrying one checkout, exactly one
reaches the counter and the rest read its answer. The recorded outcome answers a
replay for a refusal as much as for a success. The
per-customer cap is claimed BEFORE the global counter and given back by an
idempotent compensation if the counter refuses, so a per-customer rejection never
consumes global headroom and a global refusal never leaves a per-customer count
consumed.

The coupon's code is a claim document, which is both the uniqueness rule and how
`findByCode` and the admin list's case-insensitive exact search reach a coupon —
one document read, never a scan.
