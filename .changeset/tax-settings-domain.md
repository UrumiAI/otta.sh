---
"@otta-sh/domain": minor
---

Tax options (ADR-0032). `OperationalSettings.tax` (`TaxSettings`) holds tax on/off, prices
entered with tax, tax based on the shipping or the shop base address, the shipping tax class
(`inherit`, `legacy` or a fixed class), rounding at subtotal, and the cart display; it is
absent until saved, and `effectiveTaxSettings` applies the upgrade rule (rates exist, or an
outside tax calculator is registered ⇒ today's behaviour). `updateSettings` validates the block. `computeQuote` takes `deps.settings` and
returns `taxSettings`, `taxLocated` and `tax.pricesIncludeTax`; tax off asks no calculator.
`TaxRequestLine.requiresShipping` and `TotalsLineInput.requiresShipping` are new;
`TaxRulesStore.hasAnyRate()` is a new port method.
`SettingsStore.update` takes an optional `{ ifTax }` condition, checked atomically with the
write (`SettingsPreconditionFailedError` when it no longer holds). `deleteTaxClass` takes
`deps.settings` and refuses the fixed shipping tax class (`in_use_by_settings`).
The v1 order tax snapshot records `located` (a tax location matched a zone); older v1
snapshots without it read as not located, and the order email's `taxCalculated` honours it.
