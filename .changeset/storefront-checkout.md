---
"@otta-sh/plugin": minor
---

Storefront checkout — the plugin routes that close the buyer journey (ADR-0012). Additive:
no existing route, type or behaviour changes.

**Three new public routes**, registered alongside the cart block, all `public: true`:

- **`storefront/checkout/summary`** — ONE route composing three reads, in order: the cart
  read → one batched commerce lookup for its lines → the checkout quote. The commerce
  batch is one call regardless of line count (the N+1 guard). The **quote's** breakdown is
  authoritative for every total — it is what `createOrderFromCart` will charge. Returns the
  line items, the totals, a `hasUnpricedLines` flag, and the checkout idempotency key.
- **`storefront/checkout/place`** — exactly one operation, the create-order-from-cart
  command. Projects the result down to `{ orderId, state, alreadyPlaced, clientAction }`;
  `clientAction` passes through unmodified.
- **`storefront/order`** — the unauthenticated capability read (ADR-0010 §2) the
  confirmation page polls.

**The commerce client gains `quoteCheckout` / `createOrder` / `getPublicOrder`**, 1:1
mirrors of the checkout use-cases, plus the payload types (`QuoteBreakdownWire`,
`CheckoutRequestWire`, `PublicOrderWire`, `ClientActionWire`, …). The caller's
idempotency key is forwarded **verbatim** and never invented; `getPublicOrder` is the
unprivileged read, so a guest-readable page can only receive `serializePublicOrder`'s
whitelist. Every typed failure — including `PAYMENT_INTENT_FAILED` — is returned as
`{ ok: false, reason }`, never thrown.

**Honest zeros (`checkout-view-model.ts`, new).** `computeQuote` substitutes a synthetic
zero-shipping method when no `methodId` is passed and skips tax entirely when no `zoneId`
is passed, so a store with nothing configured gets `shippingCents: 0` / `taxCents: 0` —
indistinguishable at the number from genuine free shipping. An **uncomputed**
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
`ctx.http`, so checkout adds nothing to `allowedHosts` — asserted, along with Stripe's script
host being absent from the whole of `src/`, by an extended `sandbox-clean-guard` suite.
