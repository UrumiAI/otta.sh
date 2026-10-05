---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

**`orderTotalLabel(state)`** ("Paid" for every state an order reaches only after its payment
was captured — refunded included — else "Total") and **`recordedRefundTotal(refunds)`**
(recorded refunds only) in `@otta-sh/domain`; `orderTotalLabel` is re-exported by
`@otta-sh/plugin`. One rule for the order page, the account order page and the order emails.

`AccountOrderWire` (`getMyOrder`, `storefront/account/order`) gains `refundedCents`: what the
order's ledger shows refunded, read in the same ledger read as `latePayment`.
