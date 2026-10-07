---
"@otta-sh/store-emdash": minor
---

`EmdashOrderStore` now implements refunds, reconciliation resolution, fulfillment and
cancellation on the one-document order aggregate.

The refund ceiling `min(Σ captured, frozen total)` is arbitrated INSIDE the single
compare-and-set that appends the ledger row, against that same document's embedded
`payments[]` and `refunds[]` — the document revision doing what the SQL's row lock on
`orders` did, so two concurrent refunds can never each read the same headroom. The
four-state capacity lifecycle lives in that same write: `reserved` and `unverified`
hold capacity, `voided` releases it, and `finalizeRefund` is status-guarded and never
re-arbitrates. A new `refund_keys/{key}` claim collection is the once-only guard and
the only handle the settle half of the reserve-before-issue protocol has; like the
order key, it carries the whole prepared row, so a crash before the order write is
completed with the same refund id rather than reserved twice.

`resolveReconciliation` is an equality-guarded compare-and-clear, so a resolution can
never clobber an anomaly re-raised since the operator read it. Fulfillment and
cancellation ride the same guarded flip as every other state change rather than a
parallel copy of it, and a cancellation also records the hold-release intent, because
a cancelled order no longer claims its holds. The email-outbox lease landed alongside
them, since the fulfillment and cancellation specs both assert that exactly one
notification drains.

Two cross-cutting notes. The package's compare-and-set ceiling `CAS_MAX_ATTEMPTS`
rises from 12 to 24, because the order document's contention bound is money movements
(`2 × refunds-that-fit + 1` — a gateway refund writes twice) rather than inventory's
unit bound, and the refund race measured a depth of 11 against the old ceiling. Every
per-shape assertion in the package bounds the measured depth at or below the constant,
and the hand-set `CAS_ATTEMPT_BUDGET` of 8 is unchanged, so the change buys jittered
backoff on a path that would otherwise raise the typed retryable and alters no
invariant. And the email-outbox lease (`claimNextEmail`, `markEmailSent`,
`rescheduleEmail`) ships here rather than with the lists, because the fulfillment and
cancellation specs both assert that exactly one notification drains.
