---
"@otta-sh/domain": patch
"@otta-sh/plugin": patch
---

An unpublished or deleted product can no longer be sold.

The publish gate (`product_commerce.active`) and the deletion tombstone
(`deletedAt`) were only read on the listing path. So a product the merchant
unpublished or deleted could still be added to a cart (taking a stock hold),
quoted at its last price and ordered — including from a cart that held it before
the lifecycle event landed.

`@otta-sh/domain` adds `isProductLive(row)` (`active && deletedAt === null`), and
`createOrderFromCart` now refuses a cart line whose product is not live with
`PRODUCT_NOT_PRICED`. The refusal comes before anything is minted, so the line's
hold stays `held` and is released by the shopper's remove or the TTL sweep.

`@otta-sh/plugin` applies the same rule at the add-to-cart guard (an unpublished
product is refused `PRODUCT_NOT_PRICED`; a deleted one is still `SKU_MISMATCH`)
and in the checkout quote (`PRODUCT_NOT_PRICED`). No new wire reason: the
storefront already renders this token as "no longer available for purchase".
