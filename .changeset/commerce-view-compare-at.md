---
"@otta-sh/domain": minor
---

`ProductCommerceView` — the `listCommerceByIds` catalog read — now carries `compareAtPrice: Money | null`, the product's compare-at ("was") price exactly as stored, including one at or below the price (a price rise is legitimate data). Whether it reads as a sale is the storefront's decision, not the store's. The contract pins the field, the verbatim report of a below-price value, and the view's exact public key set, so the admin-only `unitCost` cannot ride a storefront read.

Additive for consumers. Implementers of `ProductCommerceStore` must supply the new field.
