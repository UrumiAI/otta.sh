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
  surrogate or NUL as U+FFFD, and log the collection, a short hash of the id and the
  field path as a boundary gap. The log never carries the text, the id or a key that
  may be shopper text (such keys print as `(key #n)`). Two object keys that would
  repair to the same text are never merged: the one that was already well formed
  (else the first) is kept and the dropped entries are logged as an error. Repair rather than refusal, because a refusal here would
  make a document written before this fix unwritable forever — an order that could
  never be expired or paid.
- **Reads heal.** When `query`, `count` or `updateIf` fails with Postgres's
  unreadable-JSON error, the guard pages the collection the one way the host never
  casts (no `where`, no `orderBy`), rewrites each unreadable document by
  compare-and-set — losing to, and never undoing, a concurrent writer — and runs the
  call once more. The host's query API has no way to skip an unreadable row, so
  repair-then-retry is the resilient read it allows. It is a one-time cost per
  legacy row. The walk is shared per collection NAME by every concurrent caller in
  the process (EmDash hands each request fresh collection objects), resumes where it
  stopped when it reaches its 1,000-page budget, fails fast for 60 s after a walk
  that saw no unreadable row, and runs past the sweep's query meter
  (`UNMETERED_COLLECTION`), since that budget is for D1 and the heal only runs on
  Postgres.
- **Ids are refused.** Every id-taking method (`get`, `getVersioned`, `put`,
  `compareAndSet`, `delete`, `compareAndDelete`, `updateIf`) rejects an id holding a
  lone surrogate or NUL with `IllFormedIdError` (`code: "STORAGE_ILL_FORMED_ID"`).
  On Postgres the driver folds such ids into one row, so repairing them would merge
  documents.
- **`where` operands are repaired** like stored text, so a lookup by the raw value
  finds the repaired row on every dialect.
