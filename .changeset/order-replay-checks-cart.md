---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

`createOrderFromCart` no longer reports success for a cart its idempotency key has
nothing to do with (#133). The replay short-circuit looked the order up by key alone, so
a stale or second checkout tab submitting the old cart's `checkout:<cartId>` key while
the cart cookie named a new cart got `ok: true` for the OLD order.

- **New reason `IDEMPOTENCY_KEY_REUSED`** on `CreateOrderFailure` (and the plugin's
  `CheckoutFailureReason`, so `storefront/checkout/place` returns it typed). A key is a
  replay only for the cart it first carried; reused for another cart it is refused, and
  nothing is minted, adopted or stamped — the submitted cart stays `active`.
- **Checked at both seams.** At the short-circuit (before the state branch, so a paid
  order is refused too), and after the deduped insert for a same-key call that raced past
  the short-circuit — which previously would have stamped the foreign order's id onto
  this cart and flipped it `checked_out`. A coupon use that racing call redeemed itself is
  released; a replayed same-key redemption belongs to the winning order and is kept.
- Same-key replays for the same cart, and `CART_CHECKED_OUT` for a new key on a placed
  cart, are unchanged.
