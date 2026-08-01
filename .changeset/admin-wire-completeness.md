---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Close the three recorded gaps where the admin wire knew something the console
could not say (INC-23). One theme — the wire stops lying by omission — across a
refunded amount that existed nowhere, a stock count the detail collapsed, and a
set size the lists never sent. Three required port members, one required wire
field and one widened wire type, hence `minor` on all four published packages.

- `@otta-sh/domain`: `PeriodBucket` gains a required `refundedCents: Cents`
  beside `revenueCents` — money returned on the orders in that bucket, per
  currency, NEVER netted into revenue. Three definitional choices are pinned by
  the contract suite rather than left to an adapter: it is bucketed by the
  ORDER's `created_at` (the same cohort `ordersByStatus` counts, so the amount
  and the refunded-order count beside it describe one set); it applies NO state
  allow-list (a fully refunded order is `refunded`, which revenue EXCLUDES —
  filtering refunds the same way would drop exactly the money the field exists
  for); and it counts FINALIZED (`status: 'recorded'`) rows only, because
  `reserved`/`unverified` hold ceiling capacity for a gateway leg that has not
  confirmed and are not money that came back. A bucket now exists when EITHER
  half contributes, so a period whose only activity was a refund is a row at
  `revenueCents: 0` instead of no row at all. Also adds
  `InventoryStore.findOnHand(sku): number | null` — the same single-row read as
  `getOnHand` with the row-presence distinction that method's return type
  cannot carry (`null` = no inventory row, `0` = out of stock); `getOnHand` is
  UNCHANGED, its `0`-for-missing collapse still pinned by its own contract
  cases. Finally `ProductCommerceStore.countProducts(filter)` and
  `CouponStore.countCoupons(filter)` join the existing `OrderStore.countOrders`,
  each sharing its list's exact predicate builder so a count can never disagree
  with the list it captions.
- `@otta-sh/store-postgres`: `revenueByPeriod` becomes a `UNION ALL` of two
  contribution sets folded by one `GROUP BY` — the two halves carry different
  predicates, and a bucket must survive when only the refunded half contributes,
  which an inner join would drop and which `FULL OUTER JOIN` cannot portably
  express (better-sqlite3 gained it only in 3.39). Measured on pg 16 (5,000
  orders over ~208 day buckets, 417 refund rows, 60 runs): p50 10.87 → 13.30 ms,
  p95 13.99 → 15.52 ms — +2.4 ms p50 (~22%), tracking the REFUND count rather
  than the order count. `countProducts`/`countCoupons` are single-table
  `COUNT(*)`s under the list predicate (no stock join — a count has no columns):
  p50 1.26 ms and 0.80 ms at 5,000 rows, against 39.3 ms and 0.60 ms page reads.
  NO MIGRATION: the refunds ledger (0020), the inventory rows and every list
  predicate already exist; no new index either.
- `@otta-sh/service`: `GET /reports/revenue` serializes `refundedCents` on every
  bucket, zero included — presence of the KEY is what tells a client the service
  reports refunds, never the value. `GET /admin/products/:id` returns
  `onHand: number | null` with the LIST's semantics (it previously collapsed
  both "no inventory row" and "no sku" to `0`, so one product read `—` in the
  list and `0` on its own detail page). The three admin list endpoints
  (`/admin/orders`, `/admin/products`, `/admin/coupons`) gain `total`, the exact
  size of the filtered set, issued CONCURRENTLY with the page read. Note for
  operators: each of those requests now holds TWO pool connections at its peak
  rather than one — the queries are short and the pool default is 8, but a
  deployment that has tuned the pool down should account for it.
- `@otta-sh/plugin`: the Reports Refunded card renders the real figure through
  `formatMoney`, including `$0.00` when the service reports zero — the em-dash
  survives only for a service that predates the field. Because a bucket can now
  exist on refunds alone, the page derives its CURRENCY MODE from
  revenue-bearing buckets only: a single fully-refunded EUR order in a USD store
  used to raise a phantom `€0.00` revenue card that dashed out AOV and
  per-product revenue, dropped the day series' zero-fill, and (via the four-card
  cap) truncated away the Refunded card in exactly the case it exists to report.
  Refund-only currencies are counted and stated separately, in their own
  currency, in one line. The card also discloses that its figure is
  retro-mutable (a July order refunded in September changes July) and that
  in-progress refunds are excluded. The product detail wire widens to
  `onHand: number | null` and renders it with the same helper as the list column;
  a sku with no inventory record no longer offers stock-movement forms whose only
  outcome is `UNKNOWN_SKU`. The list scaffold renders the EXACT count whenever a
  `total` is present, on any page — page-scoped wording remains for a service
  without one and for a screen that narrowed its own fetched page (the products
  list's "Low stock only"), and a `total` that understates the rendered rows, or
  is not a non-negative safe integer, falls back rather than lies.
