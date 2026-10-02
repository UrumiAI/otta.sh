---
"@otta-sh/domain": minor
---

`dispatchOrderEmails` and `dispatchOrderEmailsForOrder` accept `onSent(row)`, which is called
for every outbox row the drain sent, after it is marked sent, and never for a row whose send
failed. The admin console uses it to say that the buyer was emailed only when that email
really went out (QA T1-6).
