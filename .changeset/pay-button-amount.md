---
"@urumi/plugin": minor
---

The checkout pay button states the amount — "Pay $40.00", not "Pay now"
(`docs/theme/TEMPERED.md` §7). PR #130 shipped the generic label as a **disclosed
deviation** because `/checkout/pay` makes no commerce call and had no amount on it;
this closes that gap by carrying the figure forward from the moment the order was
created, rather than re-reading it on the payment page.

- **Plugin (`[Plugin]`).** `storefront/checkout/place` now returns the order's own
  `total` (`{ amount, currency, formatted }`), built by `buildOrderTotal` from the
  create reply's `totals` block and formatted through `formatMoney` — this package's
  one sanctioned money→display boundary. The route also accepts an optional `locale`,
  sanitized exactly like the summary and order routes'. No caller passes one today —
  the site sends no locale at all, so every money surface renders at the shared `"en"`
  default — so the input is there for PARITY with the summary and order routes: when
  the site does grow locale support it must hand the same tag to the review page and to
  this route, or the figure the buyer approved and the figure on the pay button will
  disagree. A malformed tag falls back rather than failing an order. The projection
  stays a whitelist: `buyerRef`, `customerId` and the ship-to snapshot still never
  leave the plugin.
- **`total` is OPTIONAL, and that is the safety property.** `buildOrderTotal` validates
  through throwing `cents()`/`currency()` constructors, and it runs after the order has
  been created — its stock held, its client secret in hand. So the formatting is
  contained: a totals block this package cannot read (absent, `"usd"`, a non-integer
  amount) is logged and the result comes back `ok: true` with no `total`. The button
  loses its amount; the payment is never lost. Callers must treat `total` as possibly
  absent — a reply that predates a deploy, or a service that widens its serializer, is
  not a failed checkout.
- **Site (`[Site]`).** The `urumi_checkout` stash widens from `{orderId, clientSecret}`
  to carry an optional `{currency, formatted}` total, captured at place-time. It is a
  snapshot on purpose — the cart it came from stays live and mutable, and the pay step
  must state the figure the PaymentIntent was actually minted for. The cookie holds
  **no money number**: minor units never leave the plugin, so nothing on the site can
  divide by 100 or re-assemble a money string (§7). The order's total is now visible to
  the client that owns the order, in a cookie that already carried the strictly more
  sensitive client secret — the buyer is being shown this figure on the very next page.
- **Backward compatible by construction.** A stash minted before this shipped stays
  valid for the rest of its 15-minute TTL, so the reader treats the total as optional
  and drops a missing or half-shaped one instead of failing: `orderId` and
  `clientSecret` are load-bearing, the amount is a label, and a label is never worth a
  payment. Those orders render the previous "Pay now" and name no currency in the
  footer — which is still the truth about what that page printed.
