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
