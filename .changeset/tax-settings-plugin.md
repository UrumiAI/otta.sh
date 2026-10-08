---
"@otta-sh/plugin": minor
---

The admin Tax page gains a "Tax options" screen (ADR-0032). The checkout quote reply carries
`breakdown.tax` (the tax per label and the display options), and `buildCheckoutTotals` returns
`taxRows` and `taxIncludedNote` for prices shown with or without tax and the tax itemized or as
one row. Stores that have saved no tax options render exactly as before. The Tax pages say when the store has rates but tax is off. Order wires carry `totals.taxLocated` when tax was calculated with no shipping zone (a digital
cart taxed at the shop base address), and `orderTotalsFlags` reads it, so such orders show the
tax charged rather than "Not calculated". A fixed shipping tax class must name an existing class.
