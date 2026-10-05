---
"@otta-sh/plugin": minor
---

Checkout on an India-based Stripe account now requires the buyer's name and address for
EVERY cart, digital and no-zone carts included (issue #382). Stripe refuses an export
payment from such an account without them, so before this a digital checkout reached the
pay step and was refused there.

- **The account's country is learned once and cached.** Saving the Stripe secret key in
  Settings reads `GET /v1/account` over `ctx.http` and caches the country in plugin kv
  (`state:stripeAccountCountry`) against a SHA-256 digest of the key. Checkout reads the
  cache; Stripe is asked again only for a different key, or after a back-off when the
  country is unknown (5 minutes when Stripe is unreachable, 1 hour after a 401, 24 hours
  after a restricted key's 403).
- **Unknown is "not required", and logged.** No key, an unreachable Stripe, a refused key
  or a restricted key without account read leaves checkout as it was (the address stays
  optional for digital carts) and logs a warning once per isolate.
- **Enforced by the commerce client.** `InProcessCommerceClient` takes a new
  `resolveAddressRequired` option, wired by `makeCommerceClient`; `createOrder` passes it to
  the domain as `addressRequired`, so the place route refuses an address-less checkout with
  `MISSING_SHIPPING_ADDRESS`. The address the buyer enters is sent to Stripe as the
  PaymentIntent's `shipping` name and address, as it already was for physical carts.
- **The summary says so.** `CheckoutSummaryView` gains `paymentAccountNeedsAddress`, and
  `addressRequired` is now also `true` when it is.
- **Settings shows the country**, read-only, under the Stripe secret key — with what to do
  when a restricted key cannot read it.
