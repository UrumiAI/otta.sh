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

**Stores that already hold duplicate rates keep their totals:** an ignored duplicate's
rate is never charged (it never was, on goods), and its "applies to shipping" flag still
counts toward the zone's shipping tax, read across every rate as before (issue #447). Line-item tax is unchanged. `getRate` returns the rate that applies. The contract harness gains
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
