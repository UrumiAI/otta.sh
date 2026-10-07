---
"@otta-sh/plugin": patch
---

The Stripe webhook route (`webhooks/stripe/settle`) now answers **200** to a
correctly signed event of a type Otta does not handle (`UNKNOWN_EVENT` — e.g.
`charge.refunded`, `charge.dispute.created`), where it used to answer 400.
Nothing is done and no order is touched; the 200 only tells Stripe to stop
retrying. Before, an endpoint subscribed to more than `payment_intent.succeeded`
and `payment_intent.payment_failed` collected 400s that Stripe retries and, after
enough failures, answers by disabling the endpoint — which stops order
settlement too.

`UNKNOWN_EVENT` is only reported after the signature verifies, so a forged body
of any type still gets 400 `INVALID_SIGNATURE`, and a malformed one still gets
400 `MALFORMED`.
