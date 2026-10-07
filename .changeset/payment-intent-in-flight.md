---
"@otta-sh/domain": minor
"@otta-sh/plugin": patch
---

A payment intent refused only because a same-key request is still being
processed is now its own checkout reason, `PAYMENT_INTENT_IN_FLIGHT`, instead of
`PAYMENT_INTENT_FAILED`.

A double-submitted checkout sends the same idempotency key twice, and the
provider answers the second "still processing". Nothing failed: asked again
shortly, the same key returns the first request's intent. `PaymentIntentError`
gains an `inFlight` flag (default false) for an adapter to say so, and
`createOrderFromCart` maps it to the new reason on both the fresh and the replay
path. The order is handled exactly as for `PAYMENT_INTENT_FAILED`: the pending
row stays and a same-key retry re-issues the intent.

**Additive to the `CreateOrderFailure` union** — an exhaustive switch over it
needs the new member. The plugin's `CheckoutFailureReason` mirrors it.
