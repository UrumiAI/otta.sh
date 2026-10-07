---
"@otta-sh/domain": minor
---

Tax options (ADR-0031). `OperationalSettings.tax` (`TaxSettings`) holds tax on/off, prices
entered with tax, tax based on the shipping or the shop base address, the shipping tax class
(`inherit`, `legacy` or a fixed class), rounding at subtotal, and the cart display; it is
absent until saved, and `effectiveTaxSettings` applies the upgrade rule (rates exist ⇒ today's
behaviour). `updateSettings` validates the block. `computeQuote` takes `deps.settings` and
returns `taxSettings`, `taxLocated` and `tax.pricesIncludeTax`; tax off asks no calculator.
`TaxRequestLine.requiresShipping` and `TotalsLineInput.requiresShipping` are new;
`TaxRulesStore.hasAnyRate()` is a new port method.
