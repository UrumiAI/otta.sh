---
"@otta-sh/domain": patch
---

`refundOrder` no longer voids a refund reservation it did not create. When a same-key
request resumes (or races into) another request's reservation and the Stripe pre-flight
answers `PROVIDER_ALREADY_REFUNDED`, the reservation is left for its owner to finalize,
instead of being voided out from under a refund that already moved money (which ended
`REFUND_ISSUED_UNRECORDED` and flagged the order for reconciliation).
