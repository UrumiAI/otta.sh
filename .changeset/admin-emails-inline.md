---
"@otta-sh/plugin": minor
---

Admin writes send the buyer's email at once, and the console says truthfully whether it went
(QA T1-6; ADR-0005's second 2026-10-02 amendment). Before this, every transition, fulfilment,
cancel and refund only enqueued its email. The cron sent it up to 15 minutes later, and out of
order when several were due, while the console said "the buyer has been emailed".

- `InProcessAdminOrdersClient` ends each write that enqueues an email with
  `sendOrderEmailsNow` for that order. The call is best-effort and bounded, and can never fail
  the write. Its results gain `email: "sent" | "queued" | "unconfigured"`, which is absent when
  the write enqueued no email (a replay, or Mark refunded). `email` is `sent` only when the row
  this write enqueued was itself delivered. The option `orderEmails` injects the inline send's
  options; a deploy passes none.
- `sendOrderEmailsNow` now resolves to `{ configured, sent }`, the rows it delivered while the
  request was still waiting. The settle routes ignore the result.
- The console's notices follow `email`: "The buyer has been emailed." only when it was sent,
  "The buyer's email is queued — it will go out within a few minutes." when it was not yet, and
  "No email was sent — this store has no email provider set up." when there is no provider. A
  status move now answers with a notice ("Order marked processing" and its email sentence).
  Mark refunded says it moved no money and emailed nobody.
