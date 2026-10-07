---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

Admin writes send the buyer's email at once and say truthfully whether it went, and every
refund email states the amount refunded (QA T1-6; ADR-0026's email amendment; ADR-0005 amended).

- **`@otta-sh/domain`.**
  - **Partial refunds email the buyer.** An admin refund (`purpose: "refund"`) that leaves
    money captured is announced by a new `refund-issued` notice (template
    `order-refund-issued`, "Refund issued", neutral wording because it also announces a lost-race
    cancellation's full refund). The notice is appended in the write that
    finalizes the refund. A cancellation whose order shipped before the flip enqueues the same
    notice for its refund.
  - **One notice mechanism.** Notices are now first-wins per `(orderId, kind, refundId)`, and
    `OrderNoticeInput` gains an optional `refundId`; the late-payment notice now carries its
    refund's id. A full refund is still announced by the `refunded` email.
  - **Refund emails state the amount.** Every refund email states "Refunded: X" through the one
    notice render path. The `refunded` state email gets the ledger's Σ refunded.
  - **`onSent(row)` on the dispatchers.** It is called for each row the drain sent, and never for
    a failed send.
- **`@otta-sh/store-emdash`.**
  - One pure notice-append transform is shared by `enqueueNotice` and the two refund writes.
  - `findNoticeEntry` takes the `(kind, refundId)` dedupe key.
- **`@otta-sh/plugin`.**
  - Each admin transition, fulfilment, cancel and refund that enqueues an email ends with
    `sendOrderEmailsNow` for that order, through the order-scoped drain the settle routes use.
  - Each write fixes its own settle-deadline as it starts, so a slow write leaves the email only
    what is left of the budget.
  - Results report `email: "sent" | "queued" | "unconfigured"`, based on whether the row this
    write enqueued was delivered, and the console's notices follow it.
  - `sendOrderEmailsNow` resolves to `{ configured, sent }`. `InProcessAdminOrdersClient` takes
    `now` for its deadlines.
- **Review round 1.**
  - A notice stored without a `refundId` (before this change) matches any refund of its kind.
  - "Queued" copy no longer promises a time: "The buyer's email is queued and will be retried
    automatically."
  - A cancel notice puts the email status before the not-restocked list and fits the list to
    the banner.
  - The lost-race cancel sends its refund notice inline and says whether it went.
