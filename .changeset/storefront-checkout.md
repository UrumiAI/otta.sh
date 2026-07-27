---
"@urumi/plugin": minor
---

Storefront checkout — the plugin routes that close the buyer journey (ADR-0012). Additive:
no existing route, type or behaviour changes.

**Three new public routes**, registered alongside the cart block, all `public: true` and all
pure `ctx.http` proxies:

- **`storefront/checkout/summary`** — ONE route composing three upstream calls, in order:
  `GET /carts/:id` → `POST /catalog/commerce/batch` → `POST /checkout/quote`. The commerce
  batch is one call regardless of line count (the N+1 guard). The **quote's** breakdown is
  authoritative for every total — it is what `createOrderFromCart` will charge. Returns the
  line items, the totals, a `hasUnpricedLines` flag, and the checkout idempotency key.
- **`storefront/checkout/place`** — exactly one call, `POST /checkout/orders`. Projects the
  reply down to `{ orderId, state, alreadyPlaced, clientAction }`; `clientAction` passes
  through unmodified.
- **`storefront/order`** — the unauthenticated capability read (ADR-0010 §2) the
  confirmation page polls.

**`HttpCommerceClient` gains `quoteCheckout` / `createOrder` / `getPublicOrder`**, 1:1
mirrors of the service's checkout endpoints, plus the wire types
(`QuoteBreakdownWire`, `CheckoutRequestWire`, `PublicOrderWire`, `ClientActionWire`, …).
Both POSTs thread `X-Service-Token` (they are non-GETs the write gate blocks);
`Idempotency-Key` is forwarded **verbatim** and never invented; `getPublicOrder` sends **no**
`X-Internal-Token`, so a guest-readable page can only receive `serializePublicOrder`'s
whitelist. Every typed failure — including the **502 `PAYMENT_INTENT_FAILED`** — is returned
as `{ ok: false, reason }`, never thrown.

**Honest zeros (`checkout-view-model.ts`, new).** `computeQuote` substitutes a synthetic
zero-shipping method when no `methodId` is passed and skips tax entirely when no `zoneId`
is passed, so a store with nothing configured gets `shippingCents: 0` / `taxCents: 0` on the
wire — indistinguishable at the number from genuine free shipping. An **uncomputed**
component therefore renders `"Not calculated"` and never `"Free"` or `"$0.00"`; a component
that genuinely *was* computed renders its money even at zero. Same rule applied to an order's
own totals on the confirmation view.

**A stable idempotency key.** `checkoutIdempotencyKey(cartId)` = `` `checkout:${cartId}` `` —
deterministic, unlike the cart forms' fresh-per-render keys. A fresh key on reload would mint
a *second* order that the `CART_CHECKED_OUT` fence then rejects, leaving the buyer with no way
forward; with this key a reload or double-submit replays into the same order and (through
Stripe's native idempotency) the same PaymentIntent. A replay whose order has already left
`pending` (`clientAction: { kind: "none" }`) is surfaced as **`alreadyPlaced`, not an error** —
treating it as one would strand a buyer whose order is already paid.

**No capability or egress change.** Stripe.js runs in the buyer's **browser**, never through
`ctx.http`, so `allowedHosts` stays at exactly one host — asserted, along with Stripe's script
host being absent from the whole of `src/`, by an extended `sandbox-clean-guard` suite.
