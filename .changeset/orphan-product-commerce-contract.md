---
"@otta-sh/domain": patch
---

`@otta-sh/domain/testing`: the `ProductCommerceStore` contract gains a delete-and-recreate case
(issue #374) — the shape the plugin's new `product-orphans` sweep completes. A soft delete leaves
the sku's stock and its live hold where they are, a replay under the same key is a no-op, and the
product re-created under a new id takes the released sku together with its stock, while the
tombstone keeps naming the sku it sold under. It pins existing behaviour on every adapter (the
in-memory fake, SQLite, Postgres, D1); no store changed.
