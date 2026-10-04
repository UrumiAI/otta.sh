---
"@otta-sh/payments-stripe": patch
---

A double-clicked checkout no longer fails with "We couldn't start a payment".

The second click sends the same idempotency key while the first request is still
creating its PaymentIntent, and Stripe answers it 409 `idempotency_key_in_use`.
That is not a failed payment: once the first request lands, replaying the same
body returns the same intent. `createIntent` now waits that out — up to four
replays of the byte-identical request, 3 s of pauses (250/500/1000/1250 ms) —
and returns the first request's intent. The wait is also capped on elapsed time
(`IN_FLIGHT_BUDGET_MS`, 3.5 s, read from the gateway's `clock`): no replay
starts past it, so slow replies cannot stretch the checkout request.

If the first request is still in flight after that, the error is thrown with the
domain's new `inFlight: true`, which checkout answers as
`PAYMENT_INTENT_IN_FLIGHT` ("busy, try again") rather than
`PAYMENT_INTENT_FAILED`. Only `idempotency_key_in_use` is replayed; any other
409, a 429 (`lock_timeout` included), a 5xx or a 4xx surfaces at once. The pauses
and the sleep are injectable (`inFlightBackoffMs`, `sleep`) for tests.
