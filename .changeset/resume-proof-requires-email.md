---
"@otta-sh/plugin": patch
---

Resuming an order's payment by email now requires the order's buyer reference to BE an
email address (and the typed value to be one). An order whose buyer reference is not an
address — a hand-seeded or legacy buyer reference without `@` —
can no longer be resumed by typing that reference back; it resumes by its cart or its
owner's session only. The email comparison is otherwise unchanged.
