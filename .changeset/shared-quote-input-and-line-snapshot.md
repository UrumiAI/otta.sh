---
"@otta-sh/domain": minor
"@otta-sh/plugin": patch
---

One quote command and one order-line snapshot, shared (ADR-0028, increment 3).
A pure refactor: no quote, total or stored order changes.

- `@otta-sh/domain`: adds `quoteCommandFor(input)` and its `PricedLine` /
  `QuoteInput` types. It builds the `computeQuote` command for a set of priced
  lines — each line's tax base at its class (`"standard"` when the row names
  none), `requiresShipping` iff any line is physical, and the destination,
  method and coupon only when given. `createOrderFromCart` now builds its quote
  with it, and maps each product row to its order line through one internal
  `snapshotOrderLine`, so any other checkout path can price and snapshot a product
  exactly as a cart checkout does, and a field the pricing pipeline gains is added in
  one place.
- `@otta-sh/plugin`: the checkout review (`quoteCheckout`) builds its quote with
  the same `quoteCommandFor`, so the review and the order are the same quote by
  construction rather than by two copies kept in step.

Characterization suites, recorded before the extraction, pin the quote command,
the quote reply, the order-store input and the stored order document byte for
byte across physical and digital goods, a declared variant, both coupon kinds,
matched, absent and unneeded zones, and USD, INR and JPY.
