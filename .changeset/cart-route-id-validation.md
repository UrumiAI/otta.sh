---
"@otta-sh/plugin": patch
---

The cart routes now hold each id to the in-process client's own bound before calling it
(#379). A `cartId` or `lineId` that is not an id token (1–200 printable ASCII characters,
no whitespace) is answered as the route's typed refusal — `INVALID_CART_ID` on
`storefront/cart/read`, `INVALID_INPUT` on `lines/add`, `lines/update` and `lines/remove` —
and an add's `productId` over 200 characters is `INVALID_INPUT`. Before, these reached the
client's throw and came back as `RENDER_FAILED` with an error log. `sku` keeps its
non-empty-only rule, because that is all the admin asks of a saved sku; an unknown one is
still `SKU_MISMATCH`. Ids the store mints are unaffected.
