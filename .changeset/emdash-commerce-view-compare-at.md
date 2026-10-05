---
"@otta-sh/store-emdash": minor
---

`EmdashProductCommerceStore.listCommerceByIds` serves the new `ProductCommerceView.compareAtPrice`, verbatim from the product document, from the same batch read — and still never `unitCost`.

Additive for consumers; the store now satisfies the widened `ProductCommerceStore` contract.
