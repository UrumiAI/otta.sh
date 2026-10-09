---
"@otta-sh/plugin": minor
---

Checkout on an India-based Stripe account now requires the buyer's name and address for
EVERY cart, digital and no-zone carts included, and every payment carries them as a Stripe
Customer (issue #382). Stripe requires the customer's name and billing address for every
international payment such an account takes. Before this, a digital checkout reached the
pay step and Stripe refused it there.

- **The account's country is read from admin Settings, never from checkout.** Saving the
  Stripe secret key reads `GET /v1/account` over `ctx.http` and caches the country in
  plugin kv (`state:stripeAccountCountry`) against a SHA-256 digest of the key. The
  Settings page load reads it again only when nothing usable is cached for the stored key:
  a key saved before this change, or an unknown answer whose back-off has run out
  (5 minutes when Stripe was unreachable, 1 hour after a 401, 24 hours after a restricted
  key's 403). The summary, the place and the Stripe gateway only read the cache.
- **Unknown is "not required", and logged.** No key, a key whose country has not been read
  yet, an unreachable Stripe, a refused key or a restricted key without read access to
  account details all leave checkout as it was, and log a warning once per isolate.
  **After upgrading, an India store must open Settings once (or save the key again)**
  for the requirement to take effect.
- **Enforced by the commerce client, for Stripe checkouts only.** `InProcessCommerceClient`
  takes a new `resolveAddressRequired` option, wired by `makeCommerceClient`. For a Stripe
  checkout, `createOrder` passes it to the domain as `addressRequired`, so an address-less
  place is refused `MISSING_SHIPPING_ADDRESS`.
- **The Stripe gateway creates the Customer.** Its `customerRequired` is answered from the
  same cache. For an India account, every PaymentIntent is preceded by
  `POST /v1/customers` (the order's name and address, Idempotency-Key
  `otta-cus-<orderId>`) and carries `customer=cus_…`, alongside `description` and
  `shipping` as before. **A restricted key on an India account needs write access to
  customers.**
- **The summary says so.** `CheckoutSummaryView` gains `paymentAccountNeedsAddress`, and
  `addressRequired` is now also `true` when it is.
- **Settings shows the country**, read-only, under the Stripe secret key — with what a
  restricted key needs: read access to account details and write access to customers.
