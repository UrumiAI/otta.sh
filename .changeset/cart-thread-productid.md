---
"@otta-sh/plugin": patch
---

Thread `productId` through the storefront add-to-cart path so a storefront cart
can be quoted and ordered (fixes #80). Previously the add-to-cart flow only ever
sent `sku`, so a cart line's `productId` persisted NULL and every checkout quote
was refused with `PRODUCT_NOT_PRICED` — the whole storefront funnel
(PDP → cart → checkout) was blocked even for a priced, active product.

The `productId` (the CMS content id — the join key to `product_commerce`) is the
piece that was missing. It is now carried end-to-end:

- `AddToCartSlot` (product view model) carries `productId` (the PDP's
  `content.id`) alongside `sku`, and echoes it in the Block Kit button value.
- The `storefront/cart/lines/add` route accepts an optional `productId`
  (validated: present-but-blank is `INVALID_INPUT`) and forwards it.
- `CommerceClient.addCartLine` gains a `productId: string | null` parameter; a
  null is carried as an omission, so a bare/legacy add behaves exactly as before.

The add-line operation itself already accepted `productId` — the storefront was
the gap. The stale `cart-routes.ts` read-handler comment (which claimed the add
hardcodes `productId: null`) is corrected; a price-annotated cart read remains a
documented follow-up.

SECURITY (surfaced in review, fixed here because threading `productId` makes it
reachable): the add-line path now RECONCILES the two independent client inputs
`sku` and `productId` against the trusted catalog. When a commerce record exists
for the `productId`, its `sku` must equal the submitted `sku`, else the add is
rejected with a typed `SKU_MISMATCH` conflict (mirrored into the plugin's
`CartFailureReason`) and no line is persisted. Without this, a caller could pair
product A's `productId` (checkout takes price/title/entitlement from it) with
product B's `sku` (order line + digital entitlement are keyed on the client `sku`)
— e.g. pay a $1 product's price while being entitled to a $1000 digital SKU, or
reserve one SKU's stock at another's price. A `productId` with no commerce row is
harmless (checkout gates on the row → `PRODUCT_NOT_PRICED`), so it is left to
default. Reject-over-substitute keeps the trusted catalog authoritative.
