---
"@otta-sh/plugin": patch
---

Resuming an order's payment by email now requires the order's buyer reference to BE an
email address (and the typed value to be one). An order whose buyer reference is not an
address — an x402 order's is the paying wallet, `x402:0x…`, which is public on chain —
can no longer be resumed by typing that reference back; it resumes by its cart or its
owner's session only. The email comparison is otherwise unchanged.
