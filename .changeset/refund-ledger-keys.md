---
"@otta-sh/admin-react": patch
---

The Orders refund ledger stops printing idempotency keys on every refund. The column
appears only when a refund's outcome is unknown — the one case where the key is how the
operator finds it in the payment provider's log, as the note above the table says — and
only that row prints its key. Settled refunds are matched by their provider id.
