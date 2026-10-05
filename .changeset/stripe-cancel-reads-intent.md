---
"@otta-sh/payments-stripe": patch
"@otta-sh/domain": patch
---

A Stripe cancel refused with `payment_intent_unexpected_state` is no longer taken to
mean "nothing to cancel" (QA2 M1b). The transport now reads the PaymentIntent, within
the cancel's own time bound, and decides from its status: `succeeded` is
`not_cancellable` (the payment landed; settle accepts or refunds it), `canceled` is
`cancelled`, and any status Stripe can still cancel from — `requires_payment_method`,
`requires_confirmation`, `requires_action`, `requires_capture`, `processing` — or a read
that fails is `retryable`, so the sweep asks again instead of leaving a payable intent
live. The domain port's `not_cancellable` now means "the intent succeeded" only.
