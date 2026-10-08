---
"@otta-sh/domain": minor
---

One tax rate per (tax class, zone). `TaxRulesStore.createRate` now refuses a second rate
for a class and zone that already has one, throwing the new `TaxRateDuplicateError`
(code `TAX_RATE_DUPLICATE`, carrying the existing rate's id and bps). Out-of-tree
`TaxRulesStore` adapters should do the same, atomically.

Duplicates already stored are kept and resolved by one rule, exported for every reader:
`effectiveTaxRates`, `appliedTaxRate` and `shadowedTaxRates` — the greatest rate id
applies, which is the rate checkout already charged. The built-in rate table now ignores
an ignored duplicate entirely, so its "applies to shipping" flag no longer taxes shipping
on its own. `getRate` returns the rate that applies. The contract harness gains
`seedUncheckedRate`, and the in-memory store a matching test seam.
