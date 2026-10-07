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

U+0000, which Postgres cannot store, is now refused as `INVALID_INPUT` in a cart add's `sku`
and `productId` and in the idempotency key of `lines/add`, `lines/update` and
`lines/remove`. On Postgres it used to fail the first store read as `RENDER_FAILED`; SQLite
hid it. The in-process client refuses it too, in `requireSku`, `requireBoundedProductId` and
every write's `requireIdempotencyKey`, and so does the admin's sku edit.

Some writes use the idempotency key as part of a document id, which the host limits to
1,024 characters. For those writes the key is now capped at 512 characters
(`IDEMPOTENCY_KEY_MAX`, enforced by the new `requireDocumentIdempotencyKey`). They are the
cart line add, update and remove, the order create, and the settings update. Product and
variant writes keep their key as a field and have no length cap, because variant sync
derives keys from CMS variant keys of any length.
