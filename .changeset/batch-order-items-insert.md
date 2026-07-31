---
"@otta-sh/store-postgres": patch
---

`KyselyOrderStore.createFromCart` now writes `order_items` in one multi-row INSERT
instead of a per-line loop of single-row inserts. An N-line checkout emits one
`order_items` statement rather than N — inside the same transaction, with an
`id` still minted per line and every column mapping unchanged. Internal adapter
perf only: no port, wire-format, or return-shape change.
