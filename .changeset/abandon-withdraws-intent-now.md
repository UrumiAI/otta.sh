---
"@otta-sh/plugin": patch
"@otta-sh/domain": patch
---

"Start a new cart" now withdraws the cancelled order's PaymentIntent at Stripe in the
same request — best-effort, under a fixed 1.5 s provider bound, started only while the
whole bound fits in a 2.5 s budget — instead of waiting for the sweep's next tick. It is
the sweep's own drain (`cancelDueIntents`) for that one order, so a definite answer is
recorded under the sweep's keys and never re-asked, a retryable one is rescheduled for
the sweep, and one that would not fit is not started. An intent the sweep gives up on is
now also flagged for reconciliation (never over an existing flag), so the orders console
shows it.
