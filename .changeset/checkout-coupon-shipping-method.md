---
"@otta-sh/plugin": minor
---

The storefront checkout routes accept the buyer's coupon and shipping method (#305,
part 1). Both `storefront/checkout/summary` and `storefront/checkout/place` take an
optional `couponCode` and `shippingMethodId`, and forward them to the quote and to the
order through one shared helper, so the review and the order are always priced from
the same selection. A client-supplied `shippingZoneId` is deliberately never read: the
tax zone is not the client's to choose (part 2 derives it from the ship-to address).
All additive.

- **A refused selection is reported, not fatal.** A mistyped, expired, exhausted or
  below-minimum coupon, or an unknown or unpriced shipping method, used to be a failed
  summary — which the site turns into a bounce to `/cart`. The summary now answers
  `ok: true` with totals computed WITHOUT the refused part, and says what was refused
  in `selectionErrors` (the coupon's code as typed, and the reason, derived from the
  wire union with `Extract<>`). `selection` states what the totals WERE computed with.
  The re-quote is bounded at three quotes.
- **Malformed values are `INVALID_INPUT`**, before any store work: a non-string or
  over-200-character coupon code, or a shipping method id that is not printable ASCII.
  The commerce client would otherwise throw, which the route guard reports as
  `RENDER_FAILED`. Coupon codes are trimmed, never case-folded: lookup is
  case-sensitive.
- **The review locks once the cart has become an order.** A same-key place replays
  that order and never re-prices it, so the summary of such a cart no longer re-quotes
  the cart: it states the ORDER — its totals, its line snapshot, its coupon — with
  `orderCreated: true` and `order: { id, state, phase }`. `phase` is `payable`
  (pending), `ended` (expired / cancelled / failed — the cart is not reopened) or
  `placed` (paid or later, or a state this build does not know). A cart whose order
  cannot be read answers the typed `CART_CHECKED_OUT`.
- **`PublicOrderWire.totals.shippingMethodId`**, beside `shippingZoneId`. The
  confirmation page's shipping row now follows the method and its tax row the zone, so
  an order charged for shipping no longer reads "Not calculated" beside a total that
  includes it.

Until part 2 lands, an order priced with a method and no zone is charged the method's
rate and no tax; the tests that pin that say it is transitional.
