---
"@otta-sh/plugin": patch
---

The Shipping method type and Coupon type dropdowns show words, not enums. A Block Kit
`select` trigger renders the option value, so QA saw `flat_rate` and `fixed_amount`; the
option values are now `Flat rate` / `Free shipping` and `Fixed amount off` /
`Percentage off`, mapped back to the enum before anything is saved (the bare enum is still
accepted). The coupon detail's `Type` reads the same words. Stored values are unchanged.
