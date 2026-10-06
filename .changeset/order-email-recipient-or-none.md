---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

An order with no email recipient is never emailed, and an admin write says so rather than
"queued" (ADR-0028 Decision 7; x402 increment 4 of 8, #376).

- **`@otta-sh/domain`.**
  - **"The order's email recipient, or none."** The outbox drain resolves the recipient in one
    place. A guest order whose `buyerRef` is not an email address — an x402 gate buyer's
    `x402:0x…` wallet reference — has none, and every row for it (state email or notice) is
    completed as **skipped**. Ordinary orders are unchanged: a guest's `buyerRef` is still sent
    to as it was typed, and a linked customer's email still wins.
  - **Breaking: `OrderStore.markEmailSkipped(id, now)`** is a new required port method. It
    completes a claimed row as skipped: terminal, never recorded as sent (ADR-0026), and not an
    attempt (the claim's count is taken back off). Only a `sending` row is skipped.
  - The dispatchers take `onSkipped(row)`. A skipped row is never passed to `onSent` and is not
    counted in the number of emails sent.
  - `emailRecipientContract` (in `@otta-sh/domain/testing`) pins one case per order template
    that can fire for an x402 order, plus the skipped completion. `InMemoryOrderStore` gains
    `outboxRows(orderId)` for it.
- **`@otta-sh/store-emdash`.** `EmdashOrderStore.markEmailSkipped`. `OutboxStatus` gains
  `"skipped"` (terminal, out of the due index), and `OutboxEntryDoc` an optional `skippedAt`.
- **`@otta-sh/plugin`.**
  - `sendOrderEmailsNow` resolves to `{ configured, sent, skipped }`.
  - `InlineEmailStatus` gains `"no-recipient"`. The console's notices say "No email was sent —
    this order has no email address." (a lost-race cancel: "No email sent: the order has no
    email address."), never "queued".
