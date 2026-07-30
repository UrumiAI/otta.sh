---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
---

Phase 6 — shipping / tax / coupons. Replaces the Phase-4 checkout-totals stub
(the naive `Σ(snapshot line price × qty)`) with a real totals pipeline built from
three pure rules engines behind ports: `subtotal → discount → shipping → tax →
grand total`, computed **deterministically in integer minor units** with **zero
float ever touching a money field**. A `fast-check` property test proves the
no-float-drift / sum-of-parts / determinism invariants across thousands of
generated carts; it is added as a new dev-dependency pinned in the workspace
`catalog:`.

- `@otta-sh/domain`: new pure, IO-free pricing engines — `allocateCents`
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
- `@otta-sh/store-postgres`: forward-only migration `0007_shipping_tax_coupons`
  (shipping zones/methods/rates, tax classes/rates, coupons + coupon_redemptions)
  and the `KyselyShippingRulesStore` / `KyselyTaxRulesStore` / `KyselyCouponStore`
  adapters on better-sqlite3 + Postgres. Coupon redemption is a single guarded
  `UPDATE coupons SET uses_count = uses_count + 1 WHERE uses_count < max_uses`
  coupled with an idempotency-guarded redemption insert — the exact shape of the
  no-oversell inventory reserve. A Postgres-required no-over-redeem concurrency
  test proves exactly `M` of `N` concurrent redeems succeed at `maxUses = M`.
  `order_totals` gets no new migration: the phase only writes richer values into
  its existing columns.
- `@otta-sh/service`: `POST /checkout/quote` (read-only totals preview, no
  redemption), the admin CRUD surface for shipping/tax/coupon config, and the
  extension of `POST /checkout/orders` in place (accepts a shipping method +
  coupon code, redeems atomically, persists the breakdown) — never renamed
  `/checkout/complete`. Wire format mirrors the ports 1:1, asserted by a
  live-server HTTP contract test.
