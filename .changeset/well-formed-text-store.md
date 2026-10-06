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
  legacy row. The walk is shared by every concurrent caller of one collection in one
  database (EmDash hands each request fresh collection objects, so it is keyed by the
  host's database handle and the collection name, not by object). A caller whose
  query failed before a walk finished retries without walking again. A walk resumes
  where it stopped when it reaches its 1,000-page budget, when a walk from the start
  saw no unreadable row and the retry still failed, failing calls fail fast for
  60 s, and the walk runs
  past the sweep's query meter (`UNMETERED_COLLECTION`), since that budget is for D1
  and the heal only runs on Postgres. A per-document repair that loses every
  compare-and-set logs it once.
- **Ids can never create a row ill-formed.** `put` and a create-if-absent
  `compareAndSet` (null revision) reject an id holding a lone surrogate or NUL with
  `IllFormedIdError` (`code: "STORAGE_ILL_FORMED_ID"`): on Postgres the driver folds
  such ids into one row, so two spellings would silently become one document. The
  methods that address an EXISTING row (`get`, `getVersioned`, `delete`,
  `compareAndDelete`, `compareAndSet` with a revision, and the update-only
  `updateIf`) pass the id through unchanged, so an id built from a legacy document's
  stored text (a reservation's sku, a buyer's email) still reaches its row. A NUL in
  such an id answers "absent" on Postgres, which refuses it as a parameter.
- **`where` operands match both spellings.** An ill-formed string operand matches
  its repaired text (how the guard stores it now) and its raw text (how a legacy
  SQLite or D1 row still holds it); a raw spelling holding NUL is left out, since
  Postgres refuses it.
