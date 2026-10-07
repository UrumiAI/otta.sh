---
"@otta-sh/plugin": minor
---

The admin Tax page gains a "Tax options" screen (ADR-0031). The checkout quote reply carries
`breakdown.tax` (the tax per label and the display options), and `buildCheckoutTotals` returns
`taxRows` and `taxIncludedNote` for prices shown with or without tax and the tax itemized or as
one row. Stores that have saved no tax options render exactly as before.
