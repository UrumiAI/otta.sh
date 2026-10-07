---
"@otta-sh/plugin": minor
---

`storefront/checkout/summary` names its lines. `CheckoutLineView.title` is the string the order records: on a live review, the commerce row's title cache, read off the batch the pricing join already makes (no extra round trip); on a review locked to an order, the order's own snapshot. `null` when the store cannot name a line — never the SKU dressed as a name. It can differ briefly from the cart page's CMS-read name right after a rename, until the sync refreshes the cache.

To carry it, `ProductCommerceBatchItem.title` and `CatalogProductCommerce.title` are new, and `buildCheckoutLines` takes the title map as a required third argument.

Additive for consumers of the routes. Implementers of `CommerceClient` (`getCommerceBatch`) must supply the new field.
