---
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
"@otta-sh/domain": minor
"@otta-sh/plugin": patch
"@otta-sh/service": patch
---

Wire the Pricing & inventory screen's "Low stock only" filter to the server-side
low-stock predicate, replacing the page-scoped client-side narrowing it used
before. The filter now applies to the whole catalogue rather than the rows on
one fetched page, and pagination works correctly across a filtered scan.

The two presentation packages take the larger bump: they LOSE exported surface,
while the plugin and the service only gain an optional field.

- `@otta-sh/plugin`: `ProductsListFilter` gains an optional `lowStockThreshold`
  field, carried on the admin Products list request once the console has
  resolved the store's threshold and the operator has asked to filter by it.
  The count line's `total` is now shown for a genuinely filtered page (the
  service's exact count describes the same rows on screen) and withheld only
  when the threshold could not be resolved and the request never carried a
  predicate — the inverse of the old narrowing days. The degradation banner
  now reports the threshold-unreadable and on-hand-unreadable causes
  independently, rather than treating either as proof the filter did not run.
  A request carrying a CURSOR is never reported as unfiltered: its predicate
  rode inside the cursor, so a settings read that fails only while paging can
  no longer claim the filter was skipped over a list that really was filtered.
- `@otta-sh/domain`: `isValidLowStockThreshold` gains an upper bound, exported
  as `MAX_LOW_STOCK_THRESHOLD`. `inventory.on_hand` is a Postgres `integer` and
  the threshold is bound against it, so a value above `int4` was refused by
  Postgres and ACCEPTED by SQLite and the fake — the same three-way adapter
  disagreement the guard exists to make unreachable, and one that surfaced as a
  500 through the catch that turns a bad threshold into a 400. Pinned in the
  contract suite, so every adapter refuses it identically.
- `@otta-sh/service`: the admin Products list query and its opaque keyset
  cursor both accept `lowStockThreshold` (a non-negative integer, mirroring
  the existing settings/report fields), and a value outside that domain is a
  400, not a 500. The query-string form is gated on plain digits rather than
  coerced, so `?lowStockThreshold=` is a 400 instead of `Number("")`'s zero —
  which would have silently narrowed the list to out-of-stock rows — and `0x10`
  and `1e2` no longer mean 16 and 100. All three threshold schemas — the list
  query, the cursor-embedded filter and the settings WRITE — now carry the
  domain's `int4` ceiling; the settings write matters most, because the saved
  value is what every later list read binds without ever appearing in a URL.
- `@otta-sh/admin-react`: the Pricing & inventory list declares the shared
  count ladder's `service-filtered` scope unconditionally now that "Low stock
  only" is a real server-side predicate, so a filtered page that exhausts the
  catalogue states its count as complete instead of always hedging with "on
  this page" / "loaded so far". The per-page note beside `Load more` is gone
  with the behaviour it described, taking its rendered element and test id with
  it. `nextPage` now LATCHES `stock.filterUnavailable` across an accumulated
  scan (and drops the exact count while it is latched): a continuation's
  predicate rides in the opaque cursor, so only the caller that keeps the pages
  can tell that rows fetched before a threshold became readable are still
  unfiltered. The count is dropped with it because the total that arrives is
  the count of every product while the operator asked for the low-stock ones —
  page one withheld its own on that ground, and honouring the second would jump
  the caption to a confident exact number under a banner saying the filter was
  skipped.
- `@otta-sh/admin-presentation`: the "Low stock only" copy stops describing the
  page-scoped behaviour it no longer has. The control's description now names
  the whole catalogue, and the filter's zero state claims the catalogue rather
  than the page ("No products are low on stock", not "No low-stock products on
  this page"). `PRODUCTS_LOW_STOCK_NO_MATCH` also drops its bespoke `scanNote`:
  a cursor is only ever emitted for a page that overflows its limit, so a
  zero-row filtered page cannot carry one, and the list ladder's default note
  still covers the rung if a caller ever reaches it. `LOW_STOCK_PER_PAGE_NOTE`
  is REMOVED — it stated the retired behaviour and had no render site left. The
  zero state is now used only when "Low stock only" is the sole active filter,
  since the predicates are ANDed and a second filter emptying the page would
  otherwise be blamed on the threshold; its sentences also say what the
  predicate found rather than claiming every product is above the threshold,
  which was never true of a product with no inventory row. The degradation
  banner's filter-unavailable remedy stops saying "Every product on this page is
  listed" — that fact latches across an accumulated scan, so it can sit over
  rows merged from several responses; it now reads "The rows below are every
  product, not just the low-stock ones."
