---
"@otta-sh/plugin": patch
---

An over-long ship-to field at `storefront/checkout/place` is the typed
`INVALID_SHIPPING_ADDRESS`, not `INVALID_INPUT`.

A buyer whose street name was longer than the domain allows used to get the
place route's generic `INVALID_INPUT` — "Something went wrong" on the storefront.
When the rest of the request is well-formed and only a ship-to field exceeds its
bound (measured after trimming), the route now answers the reason the domain
itself would give. A structurally broken body (a non-object address, a
non-string field) is still `INVALID_INPUT`.

The bounds are the domain's `ORDER_ADDRESS_MAX_LENGTHS` everywhere: the route's
parser and the in-process client's `requireShippingAddress` no longer carry
copied literals. The plugin re-exports `ORDER_ADDRESS_MAX_LENGTHS` and exports
`BUYER_REF_MAX` (320, the checkout email's bound) so a site can put the same
numbers on its inputs as `maxlength`. Additive; the bounds themselves are
unchanged.
