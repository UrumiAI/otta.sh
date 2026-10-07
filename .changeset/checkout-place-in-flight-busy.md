---
"@otta-sh/plugin": patch
---

`storefront/checkout/place` answers the domain's `PAYMENT_INTENT_IN_FLIGHT` — a
same-key PaymentIntent request still being processed, i.e. a double-submitted
checkout that outlasted the Stripe adapter's short wait — as the storefront's
retryable `{ ok: false, error: "BUSY", retryable: true }` rather than a checkout
failure. Nothing failed: the first request is about to land and a retry with the
same key returns its intent, so the shopper is told the store is busy and to try
again in a few seconds, not "We couldn't start a payment".
