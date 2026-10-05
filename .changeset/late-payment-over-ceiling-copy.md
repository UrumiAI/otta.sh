---
"@otta-sh/domain": patch
---

A second late payment on one order that would take its refunds past the order total can't be
refunded inside Otta (the refund ceiling is `min(Σ captured, total)`). Its reconciliation flag
used to say "refund it manually", which pointed at a button that refuses. It now says "Otta
cannot refund it — this order's refunds already reach its total … refund it in Stripe directly,
then resolve this flag" (issue #364). ADR-0022 also records, as accepted, that a delayed webhook
can auto-refund a buyer who paid in time, and what the operator sees when it does.
