---
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
"@otta-sh/domain": patch
---

A console refund that failed at the provider can be retried honestly.

- The refund confirm's watermark is now the FINALIZED refund total
  (`RefundsSummaryWire.finalizedTotalCents`, new). An attempt that ended
  `GATEWAY_RETRYABLE` or `GATEWAY_UNVERIFIED` holds ceiling capacity but moved no
  money yet, so it no longer makes the retry read as "someone else refunded this
  order". The retry reaches the same idempotency key: a retryable attempt resumes
  and issues once, and an unverified one answers "status unknown" again without
  calling the provider.
- A voided attempt spends its key: the refund key gains `:v<n>` (the number of
  voided attempts on the live ledger) once one exists, so a deliberate retry after
  a provider rejection is a new refund instead of replaying the rejection.
- `RefundWire` carries the row's `status`. The order detail no longer lists a
  voided attempt as a refund, labels in-progress and unknown-outcome rows, counts
  and totals only finalized refunds as "Refunded", and says when a refund's
  outcome is unknown.
- `@otta-sh/domain` exports `sumFinalizedRefunds`.
- The retry suffix counts only THIS refund's voided attempts (rows whose
  `idempotencyKey` is the refund's base key or `<base>:v<k>`), so another
  refund's rejection on the same order never moves a retryable refund off the
  key its reservation is held under. `RefundWire` carries `idempotencyKey`.
- The order detail's ledger shows the provider refund id from the wire's
  `refundRef` (it read a field the wire never sent, so it always showed "—") and
  the idempotency key an operator can match in the provider's request log.
