---
"@otta-sh/domain": minor
---

Phase 6 — shipping / tax / coupons. Replaces the Phase-4 checkout-totals stub
(the naive `Σ(snapshot line price × qty)`) with a real totals pipeline built from
three pure rules engines behind ports: `subtotal → discount → shipping → tax →
grand total`, computed **deterministically in integer minor units** with **zero
float ever touching a money field**. A `fast-check` property test proves the
no-float-drift / sum-of-parts / determinism invariants across thousands of
generated carts; it is added as a new dev-dependency pinned in the workspace
`catalog:`.

New pure, IO-free pricing engines — `allocateCents`
(largest-remainder discount apportionment, BigInt-exact so `Σ === total`
always), `computeLineTax` (half-up per-line, integer bps), `computeCouponDiscount`
(fixed-amount clamped at subtotal / percentage with cap, currency-checked),
`resolveShippingRate` (flat / free-shipping with a post-discount threshold),
and `computeTotals` composing them. New ports `ShippingRulesStore`,
`TaxRulesStore`, `CouponStore` (each with an in-memory fake + a reusable
contract suite), the `computeQuote` read-side use-case, coupon validation, the
`reconcileCouponRedemptions` crash-recovery sweep, and the extension of
`createOrderFromCart` to compute the full breakdown, redeem a coupon atomically
under the same idempotency key (releasing it synchronously if order creation
then fails), and snapshot the whole breakdown immutably into `order_totals`.
