---
"@otta-sh/store-emdash": minor
---

One stored string can no longer take a collection's queries down on Postgres
(security review R3-B, X1). EmDash's Postgres `where`, `orderBy`, cursor and
`updateIf` read every row in scope through `(data)::jsonb`, which refuses a lone
UTF-16 surrogate or U+0000, so a single guest checkout with such a ship-to city made
`listOrders` and the expiry sweep's `listExpirable` throw for the whole store (holds
never released). SQLite and D1 read both escapes and were never affected.

`collectionOf` — the one door every adapter's collections come through — now returns
a guarded collection:

- **Writes repair.** `put`, `compareAndSet` and `updateIf`'s `set` store each lone
  surrogate or NUL as U+FFFD, and log the collection, id and field path (never the
  text) as a boundary gap. Repair rather than refusal, because a refusal here would
  make a document written before this fix unwritable forever — an order that could
  never be expired or paid.
- **Reads heal.** When `query`, `count` or `updateIf` fails with Postgres's
  unreadable-JSON error, the guard pages the collection the one way the host never
  casts (no `where`, no `orderBy`), rewrites each unreadable document by
  compare-and-set — losing to, and never undoing, a concurrent writer — and runs the
  call once more. The host's query API has no way to skip an unreadable row, so
  repair-then-retry is the resilient read it allows. It is a one-time cost per
  legacy row, shared by concurrent readers.
