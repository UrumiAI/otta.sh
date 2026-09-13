# @otta-sh/store-emdash

Commerce store adapters over EmDash's plugin-storage primitives.

## The host this needs

The port is written against the **conditional-write primitives** — `updateIf`,
`getVersioned`, `compareAndSet`, `compareAndDelete`. No published `emdash`
release carries them yet. The manifest's `emdash` specifier is the plain
registry version so that adopting a release is a one-line change, and until then
the workspace override redirecting it to the vendored build is **load-bearing**:
without it the package resolves a host that lacks the primitives, and the failure
is a type error against a real installed package rather than a missing dependency.

## The seam

`src/storage-access.ts` declares a **structural `StorageAccess` port**: the nine
methods the adapters use, written in terms of the host's own types via
`import type`. Nothing in `src/` imports host code at runtime — three
dependency-cruiser rules in `pnpm lint` enforce that, the react quarantine, and
the sandbox perimeter. Production injects `ctx.storage`, tests inject a real
repository; `collectionOf<T>` is the single audited narrowing between the untyped
map and a typed collection.

## The dialect harness

`test/describe-each-dialect.ts` builds the port out of **real
`PluginStorageRepository` instances** on in-memory SQLite, and on Postgres when
`PG_CONNECTION_STRING` is set. One database per test FILE; rows are cleared
between cases. Real databases, never mocks: only Postgres can lose a race, so the
concurrency case runs there alone.

The schema always comes from the host's `runMigrations`; never hand-create the
storage table. Revisions come from a trigger that migration creates — which is
also why cases reset by emptying the table rather than recreating it.

## Known gap: no physical indexes

Declared indexes reach a collection through the repository's `indexes`
constructor argument — indexes plus unique indexes, as the host composes them —
and that argument is only the **queryable-field allow-list**. The host's
index-materializing function is unexported, so neither tier creates a physical
index, and a `uniqueIndexes` declaration enforces **nothing** here. No adapter may
depend on the host to reject a duplicate: once-only has to be enforced by a
conditional write.

## Inventory document model

`EmdashInventoryStore` implements the domain's `InventoryStore` over **one
aggregate document per SKU, with the live holds embedded in it**, plus three
per-key claim collections.

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `inventory` | sku | `onHand`, the live `holds` map, a bounded applied-movement ring | — (id lookup only) |
| `reservation_keys` | reserve idempotency key | the durable claim, then the terminal `ReserveResult` | — |
| `reservation_index` | reservation id | `{ sku, idempotencyKey }` plus the reservation's terminal state | — |
| `inventory_movements` | `stock:<key>` / `adjust:<key>` | the per-key intent, then its recorded answer | `sku`, `createdAt` |

**Why the holds live inside the inventory document.** An inventory decrement is
not idempotent unless the row records *who applied it*. So the decrement is ONE
`compareAndSet` on `inventory/{sku}` in which the `onHand >= qty` guard (computed
in JS), the new count and the hold record all commit together — no oversell and
once-only are the same atom.

**Reserve is a two-step, and its ONE crash window is the claim window.** The
sequence is: claim `reservation_keys/{key}` create-if-absent, carrying the sku, the
qty and the minted reservation id → the inventory `compareAndSet` → update the key
document to its terminal `ReserveResult`. The window is **claim written,
`compareAndSet` not yet run**. It is healed rather than merely tolerated: any
replayer of the key finds the `claimed` document and completes it deterministically,
reusing the **recorded** reservation id instead of minting a second one, so the
decrement happens exactly once and every caller gets the same answer. A sweeper
reaps claims that nothing ever replays.

What the embedded aggregate removes is the SQL adapter's *second* window — a
`pending` reservation flipped to `held` separately from the decrement. The claim
window cannot be removed by any single-document primitive, because the claim and
the units necessarily live in different documents.

**The inventory CAS step has a window of its own, and it is mitigated, not
removed.** A caller sits between reading the aggregate and committing its
`compareAndSet`; in that interval a peer completing the SAME claim can create the
hold, commit it and PRUNE it. The waking caller then sees no hold under its key and
a low `onHand` with nothing to show for it, and a *committed* prune returns no
units — so a second hold written there would be permanent, silent stock loss. The
mitigation is in the step: whenever `holds[key]` is absent, the key document is
re-read, and a terminal one ends the attempt with the recorded answer and no write.
The residual is the **one storage round trip** between that re-read and the
`compareAndSet` that follows it; removing it would need cross-document atomicity
(reading the key document and writing the aggregate in one commit), which these
primitives do not offer. INC-A3's fault-injected tier is where that round trip is
probed; a deterministic case pinning the mitigation lives in
`test/inventory-store-contract.dialects.test.ts`.

**The outcome-before-prune ordering.** A hold is pruned on commit/release, so the
terminal `ReserveResult` is written to the key document **before** the prune, and a
replay reads that document first. Prune-first-then-crash would let a replay
conclude the key was fresh and decrement a second time. The prune is the second,
idempotent step. That *ordering* is only observable under fault injection: this
package's suites pin the consequence (a replay after a prune still answers from the
key document, and creates no second hold), and the fault-injected ordering tests
belong to the race-and-crash tier.

**Why `reservation_index` is not optional.** Six port methods take reservation ids
with no sku, and a hold embedded per SKU cannot be found from an id alone. The
index document is written **before** the hold, so an id absent from it is *provably*
unknown — which is what lets `commitMany` throw `ReservationNotFoundError` for a
truly unknown id while `adoptMany` folds one into `lost`. Its create-if-absent
result is asserted: a colliding id is a loud `ReservationIdCollisionError`, never
silently adopted. The index also carries the reservation's **terminal** state,
because pruning a hold would otherwise erase the difference between "never existed"
and "existed and was released".

**Cross-SKU work is not atomic.** `adopt` / `adoptMany` / `commitMany` /
`releaseAdopted` are N per-SKU writes (one `compareAndSet` per SKU, not per id),
each idempotent by reservation id, so a partially applied set is safe for any
replayer to re-run. The order-side intent record and the completing sweeper belong
to later increments. Duplicate ids in a batch are collapsed before classification.

**Ledgers are bounded.** `adjust`, `restock` and `removeStock` keep their
once-only record in `inventory_movements` — ONE document per key, carrying the full
intent and then `applied` with the recorded result. Nothing on the hot aggregate
grows without limit: it keeps only `appliedMovements`, a ring of the last
`APPLIED_MOVEMENT_RING_SIZE` (256) applied keys with their answers, plus
`lastMovementKey` on each hold (pruned with the hold). The ring exists solely to
make the one-round-trip window between a movement's `compareAndSet` and its claim
being marked `applied` idempotent; the claim document is the durable record.

**The residual that bound leaves, and the sweeper contract that closes it.** A
replay delayed past `APPLIED_MOVEMENT_RING_SIZE` later movements on the SAME sku
loses its witness: a stock movement would apply a second time, and an `adjust`
whose hold has also been pruned throws `ReservationNotHeldError` rather than invent
a recorded answer. Closing it needs a second atomic document, which these
primitives do not offer, so it is an accepted BOUNDED residual with a contract the
sweeper must satisfy:

> A movement claim document in `inventory_movements` whose `applied` field is
> ABSENT — there is no `state` field; an absent `applied` IS the unfinished marker —
> and whose key still appears in the aggregate's `appliedMovements` ring, or as a
> hold's `lastMovementKey`, is given its `applied` record by the sweeper **before**
> that key can be evicted from the ring. The recorded result is the ring entry's
> `result`, or `{ ok: true, reservationId }` when the witness is a hold's
> `lastMovementKey`. The residual therefore requires at least ring-size movements on
> one SKU between a crash and the next sweep.

**`adjust` re-derives; it never refuses.** The port takes an ABSOLUTE target, and
the SQL reference re-derives the previous qty on every retry — a lost qty CAS rolls
its claim back with the transaction — so it always applies. This adapter matches
that: a completion reads the hold's CURRENT qty and applies `toQty` against it, and
the claim's `fromQty` is the qty observed at claim time (audit, not a guard). The
only outcomes are the port's own: `ok`, a genuine `OUT_OF_STOCK` when an increase
is not backed by units, or `ReservationNotHeldError` when the hold is no longer the
caller's to move. Every caller — the claim winner and any same-key loser — derives
its answer from the DURABLE record: the claim document's recorded result, or the
aggregate's own witness promoted onto it. First writer wins and both callers return
it, so one key can never produce two answers.

**Idempotency is always a document id.** Every claim is
`compareAndSet(id, null, …)` — a DB-level `INSERT … ON CONFLICT DO NOTHING`. No
unique index is relied on anywhere (see the known gap above). The two movement
ledgers share `inventory_movements` but never an id space, because the port scopes
keys per ledger: ids are prefixed `stock:` / `adjust:`.

**Adopting a hold with no stamped deadline is refused.** The port states the guard
as `WHERE state='held' AND expires_at > :now`, and a SQL `NULL` never satisfies it,
so an unstamped hold is not a checkout hold. The in-memory fake treats one as
adoptable and is the outlier; reconciling the fake is a follow-up outside this
adapter. The cart stamps the deadline before checkout, so this case is "never
stamped", not "live".

**The retry ceiling.** Read-modify-write on a hot SKU retries: bounded attempts
with full-jittered backoff, ceiling `CAS_MAX_ATTEMPTS = 12` (see `cas-retry.ts` for
why that number). Exhaustion throws `StorageContentionError` — typed,
`retryable: true`, carrying the last retryable host abort as its `cause` — and
deliberately **not** `OUT_OF_STOCK`: a shopper who could have bought must never be
told the item is gone. The HTTP/route boundary maps it to **503** and a retry; that
wiring is a later increment. The backoff `sleep` and jitter `random` are injectable
through the store's options, so a suite need not wait on real timers.

**No index beyond the four above.** Every access this adapter makes is by document
id, including the reservation lookups — the port has no cross-SKU listing or
expiry-scan method, so nothing here needs to query a field. The `sku`/`createdAt`
indexes on `inventory_movements` are declared for the stock-movement audit a later
increment renders, not for this store.

## Contention budget

R2 has no structural fix — the aggregate is written by read-modify-write, so a hot
SKU retries — which makes the measured retry depth a **permanent** budget rather
than an interim number. `test/inventory-crash-seams.dialects.test.ts` exports
`CAS_ATTEMPT_BUDGET` and asserts it on Postgres:

**Contention budget: measured max CAS attempts M=5/N=50 (20 loops) → 5–6,
M=1/N=100 → 2; budget asserted at 8 (< `CAS_MAX_ATTEMPTS` = 12).**

Both figures are stable across repeated runs, and both sit at M+1: only M writes can
succeed before the guard turns every remaining caller into a clean `OUT_OF_STOCK`
with no write at all, so a writer loses at most M times. Depth tracks the UNITS on
one document, not the size of the crowd.

The merchant shape is the exception worth naming: twenty guarded `removeStock`
calls racing twenty `reserve`s on one document — where a REFUSED removal still
writes its ledger entry, so the writes are not bounded by the units — does reach
the ceiling and does raise `StorageContentionError`.

**Removal shape (20 removals racing 20 reserves on 12 units, 15 loops = 600 calls):
measured max CAS attempts 12 (the ceiling), measured typed contention failures 8–29
per run; asserted at `<= CAS_MAX_ATTEMPTS` and `<= 90` (15% of the calls) respectively.**

Per-shape depth and contention, as the suite reports them per case:

| shape | max CAS attempts | typed contention failures |
|---|---|---|
| restock same key ×24 | 2 | 0 |
| removeStock same key ×24 | 2 | 0 |
| restock +10 racing 40 reserves on 5 units | 12 | 2–6 |
| restock then 40 reserves on 15 units (sequenced) | 12 | 0–1 |
| 20 removals racing 20 reserves on 12 units | 12 | 8–29 |

`restock-concurrency.pg.test.ts` reports its depth and contention count **per case**
rather than per file, so a ceiling is attributed to the shape that produced it by
evidence rather than by assumption, and it asserts what survives contention: no
over-consumption, exact conservation, never negative, at least one success per loop,
the original's lower bound (successes plus retry-exhausted callers still cover the
initial units), and every ordinary loser failing cleanly. A contention failure
writes nothing, which is why conservation still pins it. The SEQUENCED restock case
is what would catch an "everything contends" regression: it has no contention to
hide behind, so its exact honour count fails if the retry loop degrades.

## Crash seams proven

`test/inventory-crash-seams.dialects.test.ts` opens each window on real storage
with `test/helpers/fault-injection.ts` — a wrapper that delegates every method to
the real repository and only **parks** a chosen call or **throws** on it, so the
document a replay heals is the one the host would really have left behind. Every
case reads the documents back before replaying, and every case carries the
assertion that would fail if the write order were reversed.

- **(a) claim written, the inventory compare-and-set never ran** — the replay
  completes with the id RECORDED in the claim, one hold, one decrement.
- **(b) reverse-lookup entry written, the compare-and-set never ran** — the orphan
  index entry misleads no id-taking method (`commit` is the loud `COMMIT_LOST`
  anomaly; `adopt`/`adoptMany`/`commitMany`/`releaseAdopted` report it lost or
  no-op without throwing), and the claim still heals to the same id.
- **(c) the compare-and-set ran, the terminal answer was never written** — the
  replay returns the SAME reservation id, writes no second hold, and leaves
  `onHand` decremented exactly once.
- **(d) terminal answer written, the prune never ran** — a replay of the
  commit/release is a no-op success that completes the prune exactly once, a
  same-key reserve replay is answered from the key document, and a released hold's
  units come back once and only once.
- **(e) prune-before-terminal, the FORBIDDEN order** — pinned from the other side,
  because the store does not do it: the terminal write is PARKED, and while it is
  parked the hold must still be live and the units still off the shelf; the prune
  follows only after the release. This is the only test of the ordering rule, and
  a store that pruned first would pass every replay case above and fail here.
- **(f) the movement landed, its claim was never marked applied** — restock,
  removeStock and adjust each replay to the aggregate's own witness, moving
  nothing twice. Past ring eviction the suite asserts the **documented, accepted
  residual** rather than papering over it: a stock movement re-applies, and an
  adjust whose hold is also gone throws `ReservationNotHeldError`. Both cases name
  the sweeper contract above, so nobody "fixes" the test instead of the sweeper.
- **(g) a partial `commitMany` / `adoptMany` across 3 SKUs** — the first SKU
  lands, the rest stay held, and a replay of the same batch completes the
  unreached ones with the already-done ones idempotent. Note what the suite pins
  about `commitMany`: it SKIPS an id that is already terminal, so a SKU caught
  between its terminal record and its prune is completed by the singular `commit`
  a replayer or the order-intent sweeper runs, not by re-running the batch.

  **The consequence, handed to INC-C4.** A batch-only replayer therefore leaves a
  hold in the aggregate's `holds` map whose reservation is already `committed`. Its
  units are spent, so **any future expiry or reaping path must consult
  `reservation_index.terminalState` before returning units — returning a committed
  hold's units to the shelf would be an oversell**, and the hold looks live to
  anything that reads only the aggregate. The two obligations go together: the
  sweeper drives per-id `commit` (or prune) rather than re-running the batch, and
  every expiry path checks the terminal state first.
- **(h) a late same-key caller after the prune** — not duplicated here: it is the
  gated mid-flight case in `test/inventory-store-contract.dialects.test.ts`, which
  opens the same window with the same helper.
