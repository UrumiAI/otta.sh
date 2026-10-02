---
"@otta-sh/plugin": minor
---

The compare-at ("was") price reaches the storefront view model. The admin stores one per product, but no storefront read carried it. `ProductViewModel.compareAtPrice` (on `storefront/product` and `storefront/list`) is decided once, in `buildProductViewModel`: present only for a product that is for sale, in the price's currency, and strictly above the price, formatted through the one money boundary. A was-price at or below the price (a legitimate price rise) is `null`, so no theme can strike a discount the store is not giving. Display-only — `price` is still what is charged.

To carry it, `ProductCommerceBatchItem.compareAtPrice` and `CatalogProductCommerce.compareAtPrice` are new.

Additive for consumers of the routes. Implementers of `CommerceClient` (`getCommerceBatch`) must supply the new field.
