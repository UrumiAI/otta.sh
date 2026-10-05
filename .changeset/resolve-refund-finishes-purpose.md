---
"@otta-sh/domain": patch
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
---

Confirming an unverified refund now finishes what the refund was for (#364). A cancellation's
refund that timed out and is then confirmed resumes the cancel under its own key: the order is
cancelled, restocked per the first attempt's choice and sent the one cancelled email, with no
second provider call. If the order shipped meanwhile it is flagged and the buyer gets the
refund's own notice once; if the cancel cannot finish here the console says to click Cancel
order again. A late payment's confirmed refund resolves its flag and sends its notice; "it
didn't happen" flags it to refund by hand. "It didn't happen" on a cancellation's refund leaves
the order paid, and Cancel order again refunds and cancels it. `resolveUnverifiedRefund` takes
an optional `inventoryStore` and answers a `followUp`; the admin surface forwards it, and the
console copy says what happened. A cancellation whose refund is already recorded no longer needs
a gateway to finish.
