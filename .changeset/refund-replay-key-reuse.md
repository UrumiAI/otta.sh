---
"@otta-sh/domain": patch
"@otta-sh/plugin": patch
---

`refundOrder` rejects a reused idempotency key whose refund differs from the
one already stored under it (#152).

The replay check looked the key up globally and trusted the stored row's
status alone, so the same key sent with a different amount — or for a
different order — came back `{ ok: true, duplicate: true }` carrying another
refund, and a key whose reservation was still `reserved` was resumed with the
new command's amount rather than the reserved one. The stored row's `orderId`,
`amount` and `currency` must now match the command; otherwise the use-case
returns the new `IDEMPOTENCY_KEY_REUSED` failure without reserving, issuing or
recording anything. The same check runs on the store's `duplicate` outcome, so
a concurrent same-key insert with different content is rejected too. A genuine
resume re-issues the stored reservation's values.

The admin refund route maps the reason to a 409 and the Orders console shows a
"Not refunded" notice for it.
