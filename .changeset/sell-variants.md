---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

Variants are sold. A cart line is resolved to the unit it sells —
`resolveSellableUnit(product, variants, sku)` in the domain: the product's own sku
sells the product as before; the sku of a LIVE, priced variant of that product sells
the variant at its own price, under the title snapshot `<product> — <variant>` (the
variant key when the CMS gave the size no name). The add-to-cart guard, the checkout
quote, `createOrderFromCart`, the checkout summary lines and the cart read pricing all
ask the same question, so a size is added, quoted, ordered and displayed at its price.
An orphaned size or a size of another product is still `SKU_MISMATCH`; an unpriced
size is `PRODUCT_NOT_PRICED`; product liveness gates its variants; the tax class and
fulfillment kind stay the product's.

The variants come from a new batch port read, `getManyVariantsByProductId` (the
embedded variants of each product document, no stock join), issued only for the
products a line sells a size of — a cart of product skus pays no extra read. The
storefront client gains `getSellableVariantPrices(productIds)` for the pricing joins.
