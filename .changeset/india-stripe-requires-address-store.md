---
"@otta-sh/store-emdash": patch
---

`recordPaymentIntent` keeps the intent's optional `customerRef` (issue #382) on the order
document's `paymentIntents[]` entry, and `listPaymentIntents` / the order ledger return it.
Entries written before it existed read back without the field, as before.
