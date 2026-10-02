---
"@otta-sh/domain": patch
---

The cancelled email says when a refund is on its way, and for how much (QA T1-4).
`buildOrderEmailData` carries the cancellation's `refund` (`{ amountCents, currency }` or
`null`), and `renderEmail("order-cancelled", …)` adds "A refund of X is on its way to your
original payment method." whenever one was made, whatever the cancellation reason. The
reason line keeps its customer-safe allowlist.
