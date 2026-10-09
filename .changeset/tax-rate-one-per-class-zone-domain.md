---
"@otta-sh/domain": minor
---

One tax rate per (tax class, zone). `TaxRulesStore.createRate` now refuses a second rate
for a class and zone that already has one, throwing the new `TaxRateDuplicateError`
(code `TAX_RATE_DUPLICATE`, carrying the existing rate's id and bps). Out-of-tree
`TaxRulesStore` adapters should do the same, atomically.

Duplicates already stored are kept and resolved by one rule, exported for every reader:
`effectiveTaxRates`, `appliedTaxRate` and `shadowedTaxRates` — the greatest rate id
applies, which is the rate checkout already charged on goods.

**Behaviour change (stores that already hold duplicate rates):** the built-in rate table
ignores an ignored duplicate entirely, including its "applies to shipping" flag. Where the
ignored duplicate was the one marked "applies to shipping", shipping tax disappears (no
other applying rate in the zone is flagged) or moves to another class's flagged rate (it
was the last flagged rate, so it named the shipping tax class). Line-item tax is unchanged. `getRate` returns the rate that applies. The contract harness gains
`seedUncheckedRate`, and the in-memory store a matching test seam.

**BREAKING for out-of-tree `TaxRulesStore` adapters and contract harnesses:**
- `createRate` must refuse a rate id that is already live (in any class) with an error
  whose `code` is `TAX_RATE_ID_COLLISION` (the in-memory store now does too), and a
  second rate for one (class, zone) with `TaxRateDuplicateError`.
- `listRatesForZone` must list by rate id ascending (the in-memory store now does).
- `updateRate(id, input, expected)` now takes a REQUIRED expectation object
  `{ rateBps, appliesToShipping }` (was `expectedRateBps: number`): the compare-and-set
  must check both, answering `stale` on either mismatch, and a replay where the row
  already equals `input` is an idempotent `ok` (it used to be `stale`).
- `TaxRulesStoreHarness` gains a required `seedUncheckedRate(rate)`.
