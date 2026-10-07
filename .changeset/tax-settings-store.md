---
"@otta-sh/store-emdash": minor
---

The settings document stores the tax options block (absent on older documents, read as
"never saved"), and `EmdashTaxRulesStore.hasAnyRate()` answers whether any rate exists. `EmdashSettingsStore.update` honours the `ifTax` condition on every compare-and-set attempt.
