---
"@otta-sh/store-emdash": patch
---

The write guard repairs a lone surrogate or U+0000 only on Postgres (#447). On SQLite and D1,
which read such text, a write now stores it as given (and still logs it): repairing it there could
re-key a legacy document, since `inventory` and `sku_owners` are keyed by the raw sku a product
stores, so a product whose `sku` field was repaired pointed at a row that did not exist. The guard
asks the store once per collection, and only when a write first carries such text, with a
`get("\u0000")` that Postgres refuses and SQLite and D1 answer `null`.
