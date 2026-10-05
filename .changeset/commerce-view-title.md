---
"@otta-sh/domain": minor
---

`ProductCommerceView` — the `listCommerceByIds` catalog read — now carries `title: string | null`, the row's title cache: the string an order line snapshots at purchase time. It lets the checkout review name each line from the read it already makes. Pinned in `productCommerceStoreContract` (null until a sync carries one; the synced title once it does) and served by the in-memory store.

Additive for consumers. Implementers of `ProductCommerceStore` must supply the new field.
