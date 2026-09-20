---
"@otta-sh/domain": minor
---

Add a low-stock filter to the admin Products list port, so the "Low stock only"
predicate can run in the database instead of narrowing a page after the fetch.

`ProductListFilter` gains an optional `lowStockThreshold`, applied identically
by `listProducts` and `countProducts`: a row matches when its sku resolves to a
KNOWN `inventory.on_hand` count at or below the threshold. A product with no
inventory row (or no sku at all) is UNKNOWN stock, never "low" — the same
absent-is-not-zero rule the list's existing `onHand` projection already draws,
now extended to the filter itself. Omitting the field is a no-op — every
existing caller keeps seeing exactly what it saw before, and a caller that
cannot resolve a threshold should simply omit the field rather than filter to
nothing.

The field's domain is a non-negative integer. A value outside it throws the new
`InvalidLowStockThresholdError`, exported alongside its `isValidLowStockThreshold`
guard, on every adapter alike — checked before any comparison or query runs, so
a fractional or non-finite threshold can never get one answer from the in-memory
fake and a different one from a store that has to resolve the stock count.

Resolving the count is the adapter's own business, and an adapter that already
reads `on_hand` for the list's `onHand` projection pays nothing new for the
filter. Every implementation is held to the same answers by the shared contract
suite, across every case: the boundary (inclusive), zero-on-hand, the two
"unknown" shapes, the empty-match shape, out-of-domain rejection, filter
composition, and pagination.

Port-level only — no consumer wires this filter up yet.
