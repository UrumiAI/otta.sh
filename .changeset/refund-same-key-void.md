---
"@otta-sh/domain": patch
---

`refundOrder` no longer voids a refund reservation it did not create. When a same-key
request resumes (or races into) an existing reservation and the Stripe pre-flight answers
`PROVIDER_ALREADY_REFUNDED`, the money the provider shows may be that key's own earlier
issue (a crash after `refunds.create` succeeded, or a concurrent owner still in flight).
The reservation is now held `unverified` (capacity kept) and the order is flagged for
reconciliation, and the call answers `GATEWAY_UNVERIFIED`. Previously the row was voided
out from under a refund that had moved money (ending `REFUND_ISSUED_UNRECORDED`). A
reservation this call created itself is still voided, as before.
