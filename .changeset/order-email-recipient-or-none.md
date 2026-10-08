---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

An order with no email recipient is never emailed, and an admin write says so rather than
"queued" (#376).

- **`@otta-sh/domain`.**
  - **"The order's email recipient, or none."** The outbox drain resolves the recipient in one
    place. A guest order whose `buyerRef` is not an email address — a hand-seeded or legacy
    buyerRef without `@` — has none, and every row for it (state email or notice) is
    completed as **skipped**. Ordinary orders are unchanged: a guest's `buyerRef` is still sent
    to as it was typed, and a linked customer's email still wins.
  - **Breaking: `OrderStore.markEmailSkipped(id, now)`** is a new required port method. It
    completes a claimed row as skipped: terminal, never recorded as sent (ADR-0026), and not an
    attempt (the claim's count is taken back off). Only a `sending` row is skipped.
  - New exports: `isEmailAddress(value)` (the shape check `email()` applies, without
    normalizing or throwing) and `orderHasEmailRecipient(order)` (a linked customer, or a guest
    whose `buyerRef` is an email address), a pure check a caller can ask before any row is
    claimed.
  - **Behaviour change for any guest `buyerRef` with no `@`.** The checkout route
    bounds `buyerRef` by length only, so a headless storefront could create such an order. Its
    emails used to go to an undeliverable address and fail. They are now skipped.
  - The dispatchers take `onSkipped(row)`. A skipped row is never passed to `onSent` and is not
    counted in the number of emails sent.
  - `emailRecipientContract` (in `@otta-sh/domain/testing`) pins one case per order template
    that can fire for an order with no recipient, plus the skipped completion. `InMemoryOrderStore` gains
    `outboxRows(orderId)` for it.
- **`@otta-sh/store-emdash`.** `EmdashOrderStore.markEmailSkipped`. `OutboxStatus` gains
  `"skipped"` (terminal, out of the due index), and `OutboxEntryDoc` an optional `skippedAt`.
- **`@otta-sh/plugin`.**
  - `sendOrderEmailsNow` resolves to `{ configured, sent, skipped }`.
  - `InlineEmailStatus` gains `"no-recipient"`. The admin client answers it for an order with
    no recipient before the provider check, the time budget and the claim, so a spent budget or
    a missing provider never reports such an order as `queued` or `unconfigured`. Its rows are
    left to the cron, whose drain skips them.
  - The inline send's log lines say "the cron sweep will take it", not "will deliver it". The console's notices say "No email was sent —
    this order has no email address." (a lost-race cancel: "No email sent: the order has no
    email address."), never "queued".
