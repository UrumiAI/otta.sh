---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Storefront checkout now prices shipping, tax and coupons, with the shipping zone
derived from the buyer's address on the server (#305). Before this, the checkout
never sent a zone, method or coupon, so every order had zero shipping and zero tax.

- **Domain: `resolveShippingZone` / `parseShippingRegions`.** `ShippingZone.regions`
  is a `string[]` of ISO 3166-1 alpha-2 country codes (`US`) and ISO 3166-2
  subdivision codes (`US-CA`). A subdivision match beats a country match. If two
  zones match equally, the lowest zone id wins. If no zone matches, the result is
  `NO_ZONE_FOR_ADDRESS`; there is no default zone.
- **Domain: `previewCheckout`.** Takes a cart's priced lines and the destination.
  It derives the zone, offers that zone's methods priced for this cart, validates
  the optional coupon (an invalid one is reported with its reason, not thrown) and
  prices totals with tax in the same zone. `selection` is exactly what
  `createOrderFromCart` needs to produce identical totals. A digital-only cart is
  `not_required`. A store with no zones at all is `not_configured`, which keeps
  today's zero shipping and zero tax.
- **Domain: `computeQuote` refuses `SHIPPING_METHOD_NOT_IN_ZONE`** when the method
  belongs to a different zone than the one tax is priced in. `CreateOrderFailure`
  gains the same reason.
- **Plugin: `CommerceClient.previewCheckout`.** The request has no zone field.
- **Plugin: `storefront/checkout/summary`** accepts `shippingAddress` (only
  country and region are read), `shippingMethodId` and `couponCode`. It returns
  `shipping` (the derived zone and its priced methods, or a typed status) and
  `coupon` (applied or invalid with its reason). Shipping and tax totals are
  computed whenever a method or zone applies. The hard-coded
  `shippingSelected: false` is gone.
- **Plugin: `storefront/checkout/place`** derives the zone from the submitted
  address and ignores any zone in the body. It passes the zone, method and coupon
  to `createOrder`. It refuses with `SHIPPING_ADDRESS_REQUIRED`,
  `SHIPPING_UNAVAILABLE_FOR_ADDRESS`, `SHIPPING_METHOD_REQUIRED` or
  `SHIPPING_METHOD_NOT_AVAILABLE` before any order exists.
- **Plugin: the admin Shipping page validates region codes on save.** It refuses
  a country name or a wildcard and stores codes in upper case. Its help text now
  says checkout matches addresses to zones.
