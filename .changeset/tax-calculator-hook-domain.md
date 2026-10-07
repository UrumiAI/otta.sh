---
"@otta-sh/domain": minor
---

Tax calculator hook (ADR-0030). `computeQuote` now asks a `TaxCalculator` for the tax:
the built-in `otta.rate-table` (`createRateTableCalculator`) by default, which gives
bit-identical totals to the Phase 6 arithmetic and never refuses, or an outside one via
`QuoteDeps.taxCalculator` / `CreateOrderDeps.taxCalculator`. An outside calculator's
answer is checked by `validateTaxResult`; a throw, refusal, invalid answer or no answer
within 5 s (`DEFAULT_TAX_CALCULATOR_TIMEOUT_MS`) fails with the new `TAX_UNAVAILABLE`
reason, before any coupon redemption or order insert. `computeQuote` takes an optional
third argument `{ purpose: "quote" | "order" }` and returns the calculator's answer as
`tax`. The quote destination accepts an optional `postalCode` and `city`.

New orders write a typed v1 snapshot into `totals.taxBreakdown` (calculator id, and per
line the taxable amount, rate, label and tax); `readOrderTaxSnapshot` reads it, and reads
an older order's untyped breakdown as v0. `CreateOrderTotalsInput.taxBreakdown` is now
typed `OrderTaxSnapshotV1 | null`. `computeTotals` is unchanged in behaviour and is now
`computePreTax` → rate table → `assembleTotals`.
