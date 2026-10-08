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
