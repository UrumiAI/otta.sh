---
"@otta-sh/payments-stripe": patch
---

The two refund calls in the default Stripe HTTP transport — the pre-flight
`readRefundedAmount` and `createRefund` — are now bounded by `requestTimeoutMs`
(default `DEFAULT_REQUEST_TIMEOUT_MS`, 30 s) via `AbortSignal.timeout`, the same
bound `createPaymentIntent` already had. A hung Stripe can no longer hang an
operator's refund indefinitely.

Failure classification is unchanged: a timed-out READ is `retryable` (it issued
nothing; the gateway reports `RETRYABLE`), and a timed-out refund CREATE is
`ambiguous` (the POST may have reached Stripe; the gateway reports `UNVERIFIED` —
re-check before retrying, never a clean failure).
