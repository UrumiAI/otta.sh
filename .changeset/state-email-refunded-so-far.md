---
"@otta-sh/domain": minor
---

Order emails after a partial refund say what is true (QA round 2).

- A state email for an order whose money was captured (processing, shipped, delivered,
  completed) now carries `refundedSoFarCents` when the ledger shows finalized refunds,
  and renders "Refunded so far: $X" under its "Paid" total — "Paid: $10.00" alone read as
  if all of it were still held. The `refunded` and `cancelled` emails state their own
  refund, as before.
