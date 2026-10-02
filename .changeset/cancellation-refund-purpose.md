---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": patch
---

The refund ledger and the cancellation envelope can record a refund that a cancellation made
(QA T1-4).

- **`@otta-sh/domain`.** `RefundPurpose` is `"refund" | "cancellation"`. `RecordRefundInput`,
  `RefundOrderCommand` and `RefundRecord` carry an optional `purpose` (absent reads as
  `"refund"`). A `cancellation` row consumes ceiling capacity like any other but never drives
  `→ refunded`, on the one-shot record or on a later finalize, because the cancellation is what
  closes the order. `OrderCancellation` gains optional `refund` (`{ amount, currency }` or
  `null`) and `restocked`, and `CancelOrderInput` accepts both and records them verbatim.
  Pinned in `refundOrderContract` and `orderCancellationContract`.
- **`@otta-sh/store-emdash`.** `RefundEntryDoc.purpose` is stored on the row (so a resumed
  finalize reads it), and the cancel write stores `refund` and `restocked` on the envelope. No
  migration: an absent field reads as before.
- **`@otta-sh/plugin`.** `OrderCancellationWire` declares the two new fields.
