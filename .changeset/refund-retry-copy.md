---
"@otta-sh/plugin": patch
---

A refund resubmitted after it was recorded (a double click, a retry, a resubmitted
page) answers "Already refunded — nothing more was refunded" instead of "someone else
refunded this order", which blamed a stranger for the operator's own refund (QA round
2). A ledger moved by a different refund now says it was recorded "in another tab or by
someone else", and that nothing was refunded now.
