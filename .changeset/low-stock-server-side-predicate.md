---
"@otta-sh/plugin": minor
"@otta-sh/service": minor
"@otta-sh/admin-react": patch
---

Wire the Pricing & inventory screen's "Low stock only" filter to the server-side
low-stock predicate, replacing the page-scoped client-side narrowing it used
before. The filter now applies to the whole catalogue rather than the rows on
one fetched page, and pagination works correctly across a filtered scan.

- `@otta-sh/plugin`: `ProductsListFilter` gains an optional `lowStockThreshold`
  field, carried on the admin Products list request once the console has
  resolved the store's threshold and the operator has asked to filter by it.
  The count line's `total` is now shown for a genuinely filtered page (the
  service's exact count describes the same rows on screen) and withheld only
  when the threshold could not be resolved and the request never carried a
  predicate — the inverse of the old narrowing days. The degradation banner
  now reports the threshold-unreadable and on-hand-unreadable causes
  independently, rather than treating either as proof the filter did not run.
- `@otta-sh/service`: the admin Products list query and its opaque keyset
  cursor both accept `lowStockThreshold` (a non-negative integer, mirroring
  the existing settings/report fields), and a value outside that domain is a
  400, not a 500.
- `@otta-sh/admin-react`: the Pricing & inventory list declares the shared
  count ladder's `service-filtered` scope unconditionally now that "Low stock
  only" is a real server-side predicate, so a filtered page that exhausts the
  catalogue states its count as complete instead of always hedging with "on
  this page" / "loaded so far".
