---
"@otta-sh/payments-stripe": patch
---

The default Stripe HTTP transport now pins the Stripe API version: every live call —
`createPaymentIntent`, the refund pre-flight `readRefundedAmount` and `createRefund` —
sends `Stripe-Version: 2024-06-20`, from the new exported constant `STRIPE_API_VERSION`.
Previously the calls rode the account's default version, so a change to that default
could move a response shape under the adapter's parsers. `2024-06-20` postdates
`2022-11-15`, which introduced the PaymentIntent `latest_charge` field the refund
pre-flight expands.

Webhook payloads are unaffected: Stripe renders an event in the webhook endpoint's own
API version, and the event parser reads only version-stable fields.
