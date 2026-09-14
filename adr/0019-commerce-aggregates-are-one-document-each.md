# 0019. Commerce aggregates are one storage document per aggregate; idempotency is the document id

- Status: accepted, **amended 2026-09-14** — see
  [Amendment 2026-09-14 — Phase B as built](#amendment-2026-09-14--phase-b-as-built). The decision is
  unchanged and reaffirmed; the amendment corrects the statements the built adapters proved wrong, adds
  the rows they proved missing, and states four rules that recurred. Every in-place correction carries a
  **†**.
- Date: 2026-09-13
- Refines: [ADR-0002](./0002-adapter-based-split.md) — this record names the document model that
  satisfies the storage seam ADR-0002 designed, on a store with **no transactions**. The ports do not
  change; this is an adapter-side decision. It also **answers and reverses** one queued decision
  ADR-0002 implied — "backend-agnostic atomic inventory via a single-statement conditional `UPDATE`" —
  because a single guarded statement cannot carry a reserve (see the Context).
- Builds on: [ADR-0018](./0018-plugin-owns-commerce-truth-in-process.md) — the boundary this model
  lives inside. ADR-0018 admits the plugin to own commerce truth on the host's per-plugin document
  store; this record says how truth is *shaped* there.
- Relates to: [ADR-0013](./0013-product-title-is-cms-owned.md) and
  [ADR-0016](./0016-variant-title-is-cms-owned.md) — the single-writer title caches are unchanged and
  respected: a title still has one home, and the commerce document still only caches it.
  [ADR-0017](./0017-list-refresh-semantics.md) — unchanged; this record narrows what a list can
  *search*, not how it refreshes.
- Forward reference: **ADR-0020** (one deployable — the commerce service is removed), to be written.
- Amends: **nothing.**

## Context

The store a plugin gets is a per-plugin JSON document store with **conditional-write primitives and
nothing else**: a guarded update (`updateIf`), a versioned read (`getVersioned`), a revision-based
compare-and-set (`compareAndSet`), a revision-based delete (`compareAndDelete`), plus `query` and
`count` over a declared index allow-list. There is no transaction, no multi-row batch, no raw SQL and
no host DB handle. Cross-document atomicity is therefore **not available and cannot be asked for** —
a law of the primitive set, not a gap awaiting an upstream change.

The implementation being replaced is a set of Kysely stores whose correctness rests on exactly the two
things the document store lacks: multi-statement transactions and row locks. Every money-path
invariant is currently a SQL predicate — `WHERE on_hand >= qty`, a `pending` claim flip, a refund
ceiling computed under a portable row lock, two inventory rows locked in sorted order. **Those stores
are deleted at the service-removal increment**, and their semantics would go with them. Section 7 is
where they survive.

The forcing observation is narrow and worth stating alone:

> **An inventory decrement is not idempotent unless the row records who applied it.**

A reservation held "pending" somewhere else cannot distinguish crash-before-decrement from
crash-after. Recording the applying reservation *inside* the inventory row is the only fix — which is
also why the queued "single-statement conditional `UPDATE`" decision does not survive: one guarded
statement can decrement, but it cannot simultaneously record the hold that makes the decrement
replayable. Once the holds map is inside the inventory document, the same discipline resolves orders,
refunds, carts and coupons for free.

## Decision

### 1. The rule

> **An invariant that spans two facts lives in ONE storage document. A coupling that spans two
> aggregates is made idempotently completable by any replayer, and swept.**

**Aggregate-per-document is the default.** **Intent-claim plus deterministic completion** covers the
genuine cross-aggregate edges, and only those.

| Tier | Primitive | Used for |
|---|---|---|
| Lock-free fast path | `updateIf` — guard and arithmetic in one statement; no read, no retry | **†** contended **single-guard** writes, where the whole invariant is one comparison on one field |
| General read-modify-write | `compareAndSet(id, revision, nextDoc)` with bounded jittered retry | **everything multi-field**: arbitrary invariants computed in JS, committed atomically against one document |

`updateIf` reports `applied: false` for an absent row **and** for a failed guard, deliberately
indistinguishable — so a caller that needs to tell the two apart must read, which is itself a reason
most writes are `compareAndSet`.

**† How many `updateIf` sites the design has — recounted 2026-09-14, against the tree.** The original
count was "three are planned, and zero exist today", and the tier was called *pure-counter*. Both are
corrected. **Two sites exist and two is the whole set**: coupon redemption's global counter bump (§3, R1)
and the coupon **release floor** guarded on `usesCount > 0` (§7.15) — both **guarding** the same field of
the same document, one incrementing under a cap, one decrementing above a floor. (The bump's write also
stamps a best-effort witness field alongside the delta. That is deliberately *not* part of its guard, and
it is why the tier is named for what a write guards rather than for what it touches.) The third planned
site, the **email-outbox lease** (§3, R2), was built as a **`compareAndSet`** instead and belongs in the
tier below, for the reason that decides all of these: holding a lease means the writer must know *which*
document state it is extending — a lapsed peer's lease is a takeover, an absent order is a bug — which is
exactly the distinction `updateIf` refuses to report, since it conflates a failed guard with an absent
row. Hence the tier's new name. The rule the recount leaves behind is sharper than a number: **`updateIf`
is for a write whose entire invariant is one comparison on one field and whose caller needs no idea why
it failed.** Everything else — including every lease — is `compareAndSet`.

Both surviving sites take their refusal **decision from a prior read**, never from `applied: false`, for
that same reason.

**Reserve is a `compareAndSet` read-modify-write, permanently.** A guarded single statement cannot
carry it: the hold must be recorded in the same write as the decrement, and the hold lives at a nested
path. A nested-path guarded update would make reserve lock-free again, but that primitive is not being
sought, so the interim answer is the permanent one — bounded jittered retry, a documented ceiling, a
typed retryable error, and measurement.

### 2. Inventory, as built

This is the one part of the model that **exists**. The decisions and the numbers are recorded here;
the **living detail** — the per-method choreography, the eight fault-injected crash seams and the
per-shape measurements — lives in `packages/store-emdash/README.md` and is not restated here.

| Collection | Doc id | Holds |
|---|---|---|
| `inventory` | sku | `onHand`, the live `holds` map, the bounded applied-movement ring |
| `reservation_keys` | reserve idempotency key | the durable claim, then the terminal `ReserveResult` |
| `reservation_index` | reservation id | `{ sku, idempotencyKey }` plus the reservation's terminal state |
| `inventory_movements` | `stock:<key>` / `adjust:<key>` | the per-key intent, then its recorded answer |

**Reserve is a two-step, not one atom.** The plan that preceded this record described it as a single
atom; it is not, and cannot be. The sequence as built, including its two early `OUT_OF_STOCK` exits —
which differ, and the difference is load-bearing:

1. Read `reservation_keys/{key}`. A **terminal** document returns the recorded result; a **claimed**
   one is completed (this is the heal path, callable by anyone).
2. Read `inventory/{sku}`. **An absent inventory document returns `OUT_OF_STOCK` and claims nothing**
   — an unseeded sku is outside the idempotency scope and the key stays usable once the sku exists.
3. If `onHand < qty`, write the key document **straight to terminal** with `reservationId: null` and
   return `OUT_OF_STOCK`. Unlike step 2 this **does** write a document — the key is consumed — but it
   is decided **before any reservation id is minted**, so a refused reserve leaves no id and no index
   document behind, only the terminal key document that makes the replay stable. (The `null` is a field
   of the stored key document; the port's failure result has no `reservationId` field at all.)
4. Otherwise **claim** `reservation_keys/{key}` create-if-absent with a freshly minted reservation id,
   then complete: write `reservation_index/{reservationId}` (**before** the hold, its create-if-absent
   result asserted — a colliding id is a loud `ReservationIdCollisionError`), then **one
   `compareAndSet` on `inventory/{sku}`** in which the `onHand >= qty` guard, the new count and the
   hold record commit together, then promote the key document to its terminal `ReserveResult`.

Steps 1–4 sit inside a key-resolution loop bounded at **`ROUNDS = 2`**, because a create-if-absent
claim can only fail because a document now exists and the next round reads it. That loop is distinct
from — and outside — the `CAS_MAX_ATTEMPTS`-bounded compare-and-set loop within step 4. Exhausting it is
treated as contention beyond what the loop can resolve and throws the same typed retryable error as an
exhausted retry budget, never a bare failure.

**Window one: claim written, compare-and-set not yet run.** Healed, not tolerated: any replayer finds
the `claimed` document and completes it deterministically, reusing the **recorded** reservation id
rather than minting a second one. A sweeper reaps claims nothing replays. The window cannot be removed
by any single-document primitive, because the claim and the units live in different documents.

**The SQL adapter had no second crash window, and this record does not claim one.** Its `pending → held`
flip and its `on_hand - qty` decrement ran in the **same transaction with no commit boundary between
them** (§7.2), so there was nothing to crash between. What the embedded aggregate buys is therefore not a
window removed but a **simpler shape**: one write instead of two statements, no `pending` state to
observe or reap, and — because the hold in the document *is* the record of application — **no polling
loser**. The SQL adapter's race loser had to poll the reservation row up to 200 times and could time out
into an untyped error; the document model's loser completes the claim and reads its answer.

**Window two: inside the compare-and-set step, mitigated rather than removed.** Between reading the
aggregate and committing, a peer completing the SAME claim can create the hold, commit it and prune it.
The waking caller would see no hold under its key and a low `onHand` with nothing to show for it, and a
committed prune returns no units — so a second hold there would be permanent, silent stock loss. The
mitigation is in the step: **whenever `holds[key]` is absent the key document is re-read**, and a
terminal one ends the attempt with the recorded answer and no write. The residual is **one storage
round trip**, and closing it needs cross-document atomicity.

**Why `reservation_index` is not optional.** Six port methods — `commit`, `release`, `adjust`,
`releaseAdopted`, `adoptMany`, `commitMany` — take reservation ids with **no sku**, and a hold embedded
per SKU cannot be found from an id alone. Because the index is written before the hold, an id absent
from it is **provably** unknown: that is what lets `commitMany` throw `ReservationNotFoundError` for a
truly unknown id while `adoptMany` folds one into `lost`. It also carries the **terminal** state,
because pruning a hold would otherwise erase the difference between "never existed" and "existed and
was released".

#### The replay ordering rule — this is atomicity, not bookkeeping

> **The terminal answer is written to the key document BEFORE the hold is pruned from the inventory
> document.** The prune is the second, idempotent step, and it is swept. A hold may therefore be
> observed both live and terminal, and the replay path reads the key document first, treating a live
> hold as authoritative only in its absence.

Prune first, crash, and a replay finds neither a terminal answer nor a live hold, concludes the key is
fresh, and **decrements a second time** — a once-only violation on the money path. The rule is pinned
from the forbidden side: the terminal write is parked, and while parked the hold must still be live and
the units still off the shelf. A store that pruned first would pass every replay case and fail that one.

#### Movements: bounded ledgers, a witness ring, and one accepted residual

`adjust`, `restock` and `removeStock` keep their once-only record in `inventory_movements` — one
document per key, carrying the full intent and then `applied` with the recorded result. **There is no
`state` field; an absent `applied` IS the unfinished marker.** The hot aggregate keeps only
`appliedMovements`, a ring of the last **256** applied keys with their answers, plus `lastMovementKey`
on a hold — written **only by `adjust`**, and pruned with the hold.

**The accepted bounded residual, and the sweeper contract that closes it.** A replay delayed past 256
later movements on the same sku loses its witness: a stock movement would apply a second time, and an
`adjust` whose hold has also been pruned throws `ReservationNotHeldError` rather than invent an answer.
Closing it needs a second atomic document. It is therefore an accepted **bounded** residual with a
contract the sweeper must satisfy:

> A movement claim document in `inventory_movements` whose `applied` field is ABSENT — there is no
> `state` field; an absent `applied` IS the unfinished marker — and whose key still appears in the
> aggregate's `appliedMovements` ring, or as a hold's `lastMovementKey`, is given its `applied` record
> by the sweeper **before** that key can be evicted from the ring. The recorded result is the ring
> entry's `result`, or `{ ok: true, reservationId }` when the witness is a hold's `lastMovementKey`.
> The residual therefore requires at least ring-size movements on one SKU between a crash and the next
> sweep.

**Cross-SKU work is not atomic.** `adoptMany` and `commitMany` are N per-SKU writes (one
compare-and-set per SKU, not per id), each idempotent by reservation id, so a partial set is safe to
re-run; duplicate ids are collapsed first. `commitMany` **skips only an already-`committed` id**; a
`released` or `failed` one is reported `lost`, and a hold whose claim was abandoned before the hold
existed is also `lost`. So a SKU caught between its terminal record and its prune is completed by the
singular `commit` a replayer or the order-intent sweeper runs, **not** by re-running the batch. A
batch-only replayer therefore leaves a hold whose reservation is already committed: its units are
spent, so **every future expiry or reaping path must consult the reservation's terminal state before
returning units**, because returning a committed hold's units to the shelf is an oversell and the hold
looks live to anything reading only the aggregate.

#### The contention budget, as numbers

Read-modify-write on a hot SKU retries: bounded attempts with full-jittered backoff, ceiling
**†** `CAS_MAX_ATTEMPTS = 24`, first delay 2 ms doubling to a 50 ms cap. **This is a permanent budget** —
the aggregate is written by read-modify-write and there is no structural fix.

**† The ceiling was raised from 12 to 24 on 2026-09-14, and the reason is that it is not one bound.** The
original 12 was derived from inventory's shape, where **depth tracks the units on one document** (below):
a writer loses at most M times before the guard turns every remaining caller into a clean refusal with no
write at all. The **order** document has a different bound, because refunds are arbitrated inside its
compare-and-set and a state flip contends with them: `2 × refunds-that-fit + 1 flip`. A shape with
concurrent reserves and finalizes on one order therefore sits legitimately near 12 rather than near M+1,
which made an exhausted budget a flake rather than a signal. The extra attempts buy jittered backoff on a
path whose only other outcome is the typed retryable error; they do not weaken any invariant, because
every invariant is enforced by the guard inside the write and not by the attempt count. The per-shape
assertions and the tests' own tighter hand-set budget are unchanged, and the tighter one is deliberately
kept below the package ceiling so raising the ceiling can never turn a shape green by accident. **A
change to the ceiling is still a change to the budget: measure first, then move it.**

| Shape | Attempts asserted | Typed contention failures asserted | Reported measurement |
|---|---|---|---|
| 5 units, 50 racers, 20 loops (flash sale) | `<= 8` (`CAS_ATTEMPT_BUDGET`) | — | 5–6 attempts |
| 1 unit, 100 racers | `<= 8`, and `<= 6` | — | 2 attempts |
| restock +10 racing 40 reserves on 5 units, 15 loops | **not asserted** (logged per case) | **not asserted** | 12 attempts, 2–6 failures — **README measurement, no in-code figure** |
| restock then 40 reserves on 15 units, sequenced, 10 loops | **not asserted** (logged per case) | `<= 5` **per loop** (×10 loops) | 12 attempts, 0–1 failures — **README measurement, no in-code figure** |
| 20 removals racing 20 reserves on 12 units, 15 loops (**600 calls**) | `<= CAS_MAX_ATTEMPTS` | `<= 90`, i.e. 15% of calls | 12 attempts; **11–29** failures |

**† The right-hand column predates the ceiling raise and is no longer the live figure.** The **merchant
removal** shape is the one shape that reached the old ceiling and raised the typed error; raising
`CAS_MAX_ATTEMPTS` took it two or three attempts deeper and its typed failures to **zero**, which is the
whole point of the raise — attempts the loop now has are failures the caller no longer sees. The numbers
here are kept only as the record of what was measured at 12. **The live per-shape tables live in
`packages/store-emdash/README.md`** ("Contention budget", and "Coupon contention, measured" for the
coupon counter), which is where they are re-measured; cite those rather than these, and do not re-copy
figures into this record, because they drift and this record does not.

Three honesty notes on that table. The right-hand column is a **record of measurement, not an
assertion**: only the flash-sale shapes and the removal shape assert a depth at all, and the two restock
shapes merely log theirs per case, so a regression there is caught by their contention and conservation
assertions rather than by a depth ceiling. For the two restock rows the figures exist **only in the
package README** — there is no in-code comment or assertion carrying them, so nothing in the source
corroborates them and they should be re-measured rather than cited. **† The README/test disagreement this
paragraph used to name is closed.** It recorded that the removal shape's figure differed between the race
file's own comment and the README's table, and that the code comment was the one to trust; the README has
since been reconciled to the test, and the shape's figures were re-measured after the ceiling raise
besides. Note also that the sequenced row's ceiling of 5 is **per loop**, asserted ten times, not a
cumulative budget for the case.

`CAS_ATTEMPT_BUDGET = 8` — which lives in the crash-seam suite, not in the package's own constants — is
asserted to be strictly below `CAS_MAX_ATTEMPTS`, and that separation is what makes the ceiling safe to
move: a hand-set budget below the ceiling cannot be satisfied by raising it. The two flash-sale
figures sit at M+1 and are stable across runs: only M writes can succeed before the guard turns every
remaining caller into a clean `OUT_OF_STOCK` with **no write at all**, so a writer loses at most M
times. **Depth tracks the units on one document, not the size of the crowd.**

**One shape is asserted at the ceiling; two others were measured at it.** The merchant **removal**
shape is the asserted one, and the worst, because a **refused** removal still writes its ledger entry,
so its writes are not bounded by the units at all. The two **restock** shapes were measured at 12 as
well — a restock raises the unit count mid-race — but those are README figures with **no in-code
assertion**, so they are evidence, not a guarantee. The sequenced restock case is the regression
detector: it has no contention to hide behind, so its exact honour count fails if the retry loop
degrades.

**Retry exhaustion is a typed retryable error, never `OUT_OF_STOCK`.** `ReserveResult` is
`{ok:true,reservationId} | {ok:false,reason:"OUT_OF_STOCK"}` and has no member for "too busy".
Exhaustion throws `StorageContentionError` — typed, `retryable: true`, structurally discriminated by a
`code` that survives a sandbox bridge, carrying the last retryable host abort as its cause. A shopper
who could have bought must never be told the item is gone.

**Two gaps around that error, both named rather than papered over.** First, **the port does not document
it.** `ReserveResult` has no retryable member, and the `InventoryStore` contract names five typed error
classes — commit-lost, not-found, not-held, adjust-mismatch and stock-movement-mismatch — none of them
retryable. So a caller reading the port alone would not know a retryable outcome is possible: the port
docblock is **knowingly behind the adapter**, and recording the retryable outcome there is a
**docs-only `[Domain]` follow-up outside this work order**. This record does not change the domain.
Second, **the mapping to a retryable HTTP response is not built**: it will be wired at the cart-route
increment, and until then the error propagating uncaught is the intended behaviour, because it is loud.

#### Where the built store corrects the plan

| The plan said | The code does |
|---|---|
| reserve is one atom | a durable-claim **two-step** with two pre-claim exits |
| `reservation_outcomes/{key}` holds a copy of the terminal answer | there is **no second copy**: `reservation_keys/{key}` is promoted in place, so one collection carries claim and terminal. `reservation_outcomes` does not exist |
| `reservation_index` holds `{ sku }` | it holds `{ sku, idempotencyKey }` **plus** the terminal state |
| all four id-taking batch methods are `WHERE id IN (:ids)` | only `adoptMany` and `commitMany` take id sets; `adopt` is single-id and `releaseAdopted` is single-id **and** order-scoped |

One further honesty note, **† now closed (2026-09-14).** This said `release` on a reservation that is
neither live nor already released still threw an **untyped** `Error`, exactly as the SQL store did, and
that typing it was an open follow-up. It **is** typed: `ReservationNotReleasableError`, an **adapter**
error carrying the reservation id, the state it was found in, and a structural `code` that survives a
sandbox bridge. It is adapter-level rather than the domain's `ReservationNotHeldError` because that class
is the port's `adjust` failure and its message would be false here; widening the port to cover `release`
remains a domain change with its own PR. The reason it needed typing at all is a real caller: the cart
expiry **swallows** this case, because a hold an order has already committed is not the cart's to return,
and an untyped error forces that caller to match on a message. The message text is unchanged from the
bare error it replaces, so nothing reading the text had to change.

### 3. The design the remaining adapters implement

Inventory is built. **Everything in this section is design the remaining adapters must satisfy, not a
description of code that exists.**

| Coupling | Shape | Invariant preserved | Proven by | Owning increment |
|---|---|---|---|---|
| Order creation from a cart | **(b)** `order_keys/{idempotencyKey}` intent claim carrying the full intent, then **(a)** create-if-absent of one `orders/{orderId}` document holding header, `readonly items[]`, totals and address | replay once-only; snapshot immutability becomes structural | `order-store-contract`, `order-flow` | order-store core |
| Refunds and their capacity | **(a)** `payments[]` and `refunds[]` embedded; the ceiling computed **inside** the read-modify-write and committed by the same compare-and-set; plus `refund_keys/{refundKey} → orderId`, because the settle path has only the key | ceiling never exceeded; refund once-only | `refund-order-contract`, `refund-race` | order-store refunds |
| State transition | **(a)** the guarded flip, the `events[]` append and the first-wins `emailOutbox[]` entry are **ONE** compare-and-set guarded on revision and on `state === from` | transition once-only; audit completeness | `order-transition-contract`, `order-timeline-contract`, `outbox-dispatch` | order-store core |
| Email-outbox lease | **†** **(a)** `emailDueAt` as the denormalized candidate filter, claimed by a revision `compareAndSet` on the order document (R2 below), plus **(b)** an `outbox_keys/{entryId} → orderId` locator, because the dispatcher settles by entry id alone | a message is sent once and a crashed dispatcher's row becomes claimable again | `outbox-dispatch` | order-store lists |
| Orders list, search and customer view | **†** **(a)** four denormalized indexed fields — `searchKey`, `buyerRefLower`, `customerKey`, `emailDueAt`; the customer filter stays a union and is resolved as **two merged indexed arms** counted by inclusion–exclusion, because R3's conditional fired (R3 below, and §6) | one row per order; count agrees with the page; a guest's not-yet-relinked orders are neither undercounted nor mislabelled | `order-store-contract` list cases, ADR-0017's refresh cases | order-store lists |
| Hold adoption / commit across N SKUs | **(b)** the order document records the adoption/commit **intent** before any per-SKU write; each per-SKU write is idempotent by reservation id; a sweeper completes a partial set; reservation id → sku from `reservation_index` | a paid order never has a hold left un-committed and then reaped | `inventoryStoreContract` batch cases, multi-line checkout race | order-store core + sweeper |
| Sku rename | **(b)** one compare-and-set on the source zeroes `onHand` and stamps `transferOut: { token, toSku, qty }`; the target applies iff `appliedTransfers` lacks the token (bounded ring); the source clears it. **†** The carry runs **after** the product write commits, which makes the product document's own compare-and-set the mutual exclusion — and makes the held-stock refusal advisory rather than structural (§7.6) | stock conservation; the held-stock refusal **as a weakening**; idempotent replay | `product-commerce-store-contract`, `sku-rename-ledger`, `sku-rename-race`, `variant-sku-rename-race` | product-commerce store |
| Live-sku uniqueness across two grains | **(b)** `sku_owners/{sku}` claim doc (R4 below) | one live owner per sku, across products **and** variants | `product-commerce-store-contract` precedence cases | product-commerce store |
| Cart hold expiry | **(b)** guarded flip of the line to `expiring` (once-only token) → release the reservation → remove the line. Today's fixed **lock** order becomes a fixed **step** order. A sweeper completes a partial | hold expiry returns stock exactly once | `cart-store-contract`, `hold-expiry`, `cart-fence`, `no-oversell-cart` | cart store |
| Coupon redemption | **(b)** then **(a)** — per-customer claim first, then the global counter (R1 below) | no over-redeem; **a per-customer rejection never consumes global headroom** | `coupon-store-contract`, `coupon-lifecycle`, `coupon-no-over-redeem` | coupon store |
| Reporting rollups | **(b)** keyed on the order's **creation** day, so a transition decrements one bucket and increments another **in a past bucket**; `ordersByStatus` moves an order between state buckets; **refunds roll up independently of transitions**; idempotent per `(orderId, transition)` and **swept** | reported figures equal a from-scratch replay | `reporting-store-contract`, `reporting.seeded`, plus a crash-between-transition-and-rollup case **to be written** | reporting store + sweeper |

Six of these needed a ruling, because the naive translation is wrong.

**† R1, amended 2026-09-14 — once-only moved into the key document, and the bump step became a lease.**
The inverted order below is as built and unchanged, but two things were added because neither the counter
nor the per-customer claim can carry once-only for *N callers completing one idempotency key*, which is
what a retried checkout looks like. First, **once-only lives in the redemption key document's own state
machine** — `claimed → bumping → applied | refused`, where `claimed → bumping` is a one-winner revision
compare-and-set and only the winner reaches the counter, every loser reading the winner's recorded answer
back. That is what lets the `updateIf` guard **carry the cap and nothing else** (§1): pinning a per-key
witness into the guard instead would turn the delta into a revision compare-and-set, making every
redemption contend with every *other* redemption of the same coupon so retry depth grew with the
**crowd** rather than the headroom — and it would not even be sufficient, because a peer's bump
overwrites the shared witness and a same-key replayer that no longer sees its own key there bumps again.
Second, **the bump right is leased**, because a step held by a slow owner and one held by a crashed owner
are the same document: it carries a deadline (`COUPON_BUMP_LEASE_MS`, 10 s, overridable per store as
`bumpLeaseMs`), a waiter takes it over only once that lapses, and until then it re-reads and finally
raises the typed retryable contention error so the caller's own retry reads the recorded answer. The
lease is re-asserted by a heartbeat compare-and-set immediately before every counter write, per retry —
the cross-cutting owner-token rule in the Amendment. The **residual is one HIGH, never one LOW**: a `+1`
that lands and then crashes before `applied` is recorded, with the lease lapsed and the witness
overwritten, over-counts by one and never under-counts, so the coupon can only ever refuse a redemption
it could have allowed. Exactness is restored by the coupon recount sweeper.

**R1 — coupon redemption cannot roll back.** The SQL bumps the global counter and *then* counts the
customer's redemptions, and a per-customer refusal is undone by the **transaction**. A transactionless
store has no such undo, so the order is inverted: **claim `coupon_customer_caps/{couponId}:{customerId}`
first** by compare-and-set, then bump the global counter (`updateIf` guarded on `usesCount < maxUses`
when capped, an unguarded delta when uncapped — an uncapped coupon has no invariant to violate); if the
global bump is refused, **release the per-customer claim** as an idempotent compensation. The per-key
replay record is a **separate** document, `coupon_redemptions/{couponId}:{idempotencyKey}`. A crash
between the two writes leaves a claimed-but-unapplied redemption that the sweeper completes or
releases. The invariant to hold: **a per-customer rejection never consumes global headroom.**

**R2 — the email lease has an OR and a negation.** The SQL claims on
`sent_at IS NULL AND status != 'failed' AND (lease_until IS NULL OR lease_until <= now)`, which the
filter algebra cannot express. Denormalize **one** indexed field, `emailDueAt`: `null` when the message
is sent or failed, otherwise `max(dueAt, leaseUntil)`. The candidate query is then one range on that
field.

**† Corrected 2026-09-14 — the claim is a `compareAndSet`, not an `updateIf`, and the lock-free path does
not survive here.** This clause promised "a single `updateIf` guarded on `emailDueAt <= now` that sets
`emailDueAt = now + leaseLength` and increments attempts". Two fields and an increment are already past
what the tier is for (§1), but the deciding reason is a correctness one: the entry being leased is
**embedded in an order document** alongside everything else that order's writers touch, so the write has
to be a read-modify-write against that document's revision no matter how simple the guard reads. And a
claimant must know *why* it failed — a lapsed peer's lease is a takeover, an absent order is a bug —
which is exactly what `updateIf` refuses to report. So `emailDueAt` is the **candidate filter** and the
revision compare-and-set is the **claim**, with the range re-applied to the fetched document. This is
strictly stronger than the design asked for, and it is the shape every other lease in the package copied
(§1, and the cross-cutting owner-token rule in the Amendment).

**R3 — the customer filter is a UNION, and it stays one.** It is not a convenience OR that can be
collapsed to a single equality. Orders are born with `customer_id = NULL` and are back-linked only at the
customer's **next** magic-link login, so at query time one human owns both linked rows and
not-yet-relinked ones: the port is explicit that a `customer_id`-only predicate **silently undercounts**
and a `buyer_ref`-only one **mislabels**, which is why the key is
`customer_id = :id OR lower(buyer_ref) = lower(:ref)`, folded but exact because it is an identity
predicate rather than a fuzzy lookup.

The design therefore keeps the union and moves it into the value set. The order document carries **one**
indexed `customerKey = customerId ?? foldedBuyerRef`, rewritten by `linkGuestOrders`, and the filter
becomes **`customerKey in [customerId, foldedBuyerRef]`** — the filter algebra supports `in`, so this is
one clause on one indexed field, one row per order is preserved because a document matches a set once,
and `countOrders` shares the identical predicate.

**The one narrowing this introduces, handed to the lists increment.** An order whose `customer_id` is a
**different** customer but whose `buyer_ref` folds to *this* customer's email matched the SQL union and
will **not** match `customerKey in [...]`, because that order's key holds the other customer's id. If a
contract case pins that edge, the lists increment must keep a **second** indexed `buyerRefLower` field
and resolve the OR another way — and must say so in its PR. Checking the contract for such a case is part
of that increment's work, not an assumption made here.

The created-at window needs no denormalization at all: it is half-open
`createdAt >= from AND createdAt < to`, which maps to `gte`/`lt` directly.

**R4 — live-sku uniqueness spans two grains.** `sku_owners/{sku}` is a claim document carrying
`{ ownerKind: "product" | "variant", ownerId, live: boolean }` — **†** and, as built, a `variantKey` for
the variant grain, a `claimedAt` that makes it a lease, and a `createsTarget` flag (both below). A
soft-delete or an orphaning **releases** the claim, and a new claimant may take over a released one by
compare-and-set. `SkuConflictError` outranks `SkuStockConflictError` exactly as today. The two partial
unique indexes' semantics — unique **among live rows only** — thereby become a document invariant instead
of a database feature the document store does not have.

**† R4, amended 2026-09-14 — the claim is a LEASE, and it is taken before the write it protects.** A
claim taken and then abandoned by a process that dies cannot be given back in a `finally`, so a plain
claim document would strand the sku forever. It therefore carries an age and resolves to one of four
statuses — **held** (backed by a live owner document), **owed** (a peer still owes a stock carry on it,
so it must not be taken no matter how old), **in-flight** (young enough that its holder is presumed
alive) or **abandoned** (older than `CLAIM_ABANDON_AFTER_MS`, 60 s, overridable per store as
`claimAbandonAfterMs`), and only an **abandoned** one may be taken over. The lease is why the owner-token
rule exists: a writer parked past the abandon window is taken over, wakes, and would otherwise commit its
product write against a sku it no longer holds, leaving **two live rows on one sku** — so the claim's
revision is re-asserted by a heartbeat compare-and-set immediately before every sku-bearing product
write, on **every attempt** of the retry loop, and an overtaken writer is refused with `SkuConflictError`
(surfaced as `SKU_TAKEN`) rather than committing. Withdrawal is gated on a `createsTarget` flag recorded
on the claim, which says whether this claim **created** the target's inventory document or **adopted** a
pre-existing one: only a created one may be withdrawn, because withdrawing an adopted document would
delete units that were never this owner's. The accepted residuals are named in the Amendment.

**R5 — `adjust` loses its qty CAS and is serialised by the document revision instead.** The SQL
serialised an adjust against a concurrent checkout on one hold with a CAS on the hold's own previous qty
(`WHERE … AND qty = :prevQty`), and a lost CAS **aborted the transaction** and re-ran the whole
choreography. There is no transaction to abort here, and no per-hold version to compare. The replacement
guard is **the inventory document's own revision**: any checkout-side change to that hold bumps the
revision, so a concurrent adjust's compare-and-set loses, re-reads, and applies the port's **absolute**
target against the hold's *current* qty — which is also why the built store re-derives from the hold
rather than trusting a remembered previous qty. The claim's recorded `fromQty` is audit, not a guard.
Proven by `adjust-concurrency.pg.test.ts`, re-pointed at the document adapter. See §7.12's guard-3 row.

**R6 — refunds have a four-state capacity lifecycle.** The states are `recorded`, `reserved`,
`unverified` and `voided`. Every non-`voided` row **holds capacity**; `voided` releases it and stays as
an audit record. Arbitration is `activePrior + amount > ceiling` over that active sum, and it happens
**only** on the reserve/record path: `finalizeRefund` is **status-guarded** (`reserved` or `unverified`
only) and **never re-arbitrates**, because the reservation already holds the capacity. `voidRefund` and
`markRefundUnverified` are guarded flips out of `reserved`. All of it — the active sum, the arbitration
and the state flip — happens inside the order document's single compare-and-set. The three cases that
pin it are the ambiguous-timeout case (a `voided` row releases capacity while an `unverified` one holds
it), the fail-closed case (an already-refunded gateway voids the reservation and releases capacity), and
the status-guard case (a stray finalize never clobbers a voided row, and a same-ref re-finalize is a
benign duplicate).

### 4. The collection layout, and doc-id idempotency

One collection per aggregate, one per ledger with no aggregate, plus the lookup collections the port
signatures force. Declared on the descriptor's `storage` field.

**† means one thing: the row was verified against the adapter as built, on 2026-09-14.** Some daggered
rows were corrected to match it and some already did; the mark says the row has been checked against
code, not that it changed. A row with no **†** is still design. See the
[Amendment](#amendment-2026-09-14--phase-b-as-built) at the end of this record.

| Collection | Doc id | Declared indexes | Unique indexes |
|---|---|---|---|
| `inventory` | sku | — | — |
| `reservation_keys` | reserve idempotency key | — | — |
| `reservation_index` | reservation id | — | — |
| `inventory_movements` | `stock:<key>` / `adjust:<key>` | `sku`, `createdAt` | — |
| `carts` | cartId | `state`, `holdExpiresAt` | — |
| **†** `cart_mutation_index` | cart mutation idempotency key | — | — |
| **†** `orders` | orderId | `state`, `createdAt`, `customerKey`, `buyerRefLower`, `searchKey`, `emailDueAt`, `holdExpiresAt`, `holdsPendingAt`, `[state, createdAt]` | — |
| `order_keys` | order idempotency key | — | — |
| `refund_keys` | refund idempotency key | — | — |
| **†** `payment_refs` | provider reference | — | — |
| **†** `outbox_keys` | outbox entry id | — | — |
| **†** `order_notes` | note idempotency key | `orderId` | — |
| **†** `order_sku_index` | `${foldedSku}:${orderId}` | `[sku, createdAt]` | — |
| **†** `product_commerce` | productId | `productId`, `lifecycle`, `publishKey`, `productKind`, `taxClass`, `createdAt` | — |
| `sku_owners` | sku | — | `sku` (declared; **not** the enforcement) |
| **†** `coupons` | couponId | `createdAt` | — |
| **†** `coupon_codes` | folded code | — | — |
| **†** `coupon_redemptions` | `${couponId}:${idempotencyKey}` | `couponId`, `orderId`, `createdAt`, `redemptionId`, `holdsUse` | — |
| `coupon_customer_caps` | `${couponId}:${customerId}` | — | — |
| **†** `customers` | customerId | `emailLower` | — |
| **†** `customer_emails` | folded email | — | `emailLower` (declared; **not** the enforcement) |
| **†** `sessions` | token hash | `customerId` | — |
| **†** `login_challenges` | challengeId | `consumed`, `expiresAt` | — |
| **†** `login_challenge_claims` | folded email | — | — |
| **†** `entitlements` | grant idempotency key | `orderId`, `buyerRefLower`, `sku`, `state` | — |
| **†** `entitlement_lookups` | `order:{orderId}:{sku}` / `buyer:{foldedRef}:{sku}` | — | — |
| **†** `payment_events` | dedupe key | — | — |
| **†** `payment_anomalies` | digest of the anomaly's own fields | — | — |
| `shipping_zones` / `tax_classes` | zoneId / classId | — | — |
| **†** `shipping_method_owners` / `tax_rate_owners` | methodId / rateId | — | — |
| **†** `settings` / `settings_mutations` | `"store"` / mutation key | — | — |
| **†** `reporting_daily` | `${currency}:${YYYY-MM-DD}` | `currency`, `date` | — |
| **†** `reporting_applied` | `{orderId}:{fromState}>{toState}` — with an EMPTY `fromState` arm for an order's arrival, `{orderId}:>{toState}` — or `{orderId}:refund:{refundId}`; every part percent-escaped for `%`, `:` and `>`, so two ids cannot collide | `date`, `orderId` | — |

**† Why the claim collections outnumber the aggregates.** Six of the marked rows are one device under
six names. `payment_refs`, `outbox_keys`, `cart_mutation_index`, `coupon_codes`,
`shipping_method_owners` and `tax_rate_owners` each exist because a port method is handed an id — a
provider reference, an outbox entry id, a mutation key, a code, a method id, a rate id — with **no
parent**, and a fact embedded in a parent document cannot be found from one. That is
`reservation_index`'s reason (§2) applied six more times, and each is create-if-absent on its own id,
so the reverse lookup and the uniqueness are the same write. The package README's "The outbox locator"
and "Why two claim collections, where the design table names none" carry the per-collection detail,
including which bracket direction is healable. Two of the six answer a port method that takes a child
id the port never pairs with a parent — nine such methods across the two rules stores. And
`reporting_applied` is none of those six: like `coupon_redemptions` it is an IDEMPOTENCY claim
whose parent is known (the order the event belongs to, and the day document its effect lands
in), keyed by the event rather than by a lookup nobody else can serve — its second job is to
be revocable, since a recompute that counts an event absolutely must be able to stop that
event's delta from ever applying.

**† The product document's index list has no `sku` and no `titleLower`, and `active` is filtered
through a text mirror.** Nothing queries `product_commerce` by sku — live-sku uniqueness is the
`sku_owners` claim, reached by document id, and a variant's sku is not a field of its product document
at all, so the index would answer half the question. `titleLower` is dropped because the port's title
search is a **substring** and the filter algebra has none, so declaring it would be a read contract for
a query never issued; that half of the search is resolved in memory over rows the indexed axes already
narrowed. `active` stays a boolean field the port reads back, but the *filter* binds `publishKey`, an
indexed two-value text mirror, because one dialect cannot bind a boolean as a `where` value.
`lifecycle` (a three-state tombstone axis — the algebra has no negation, the archive view needs one,
and a document may hold variants before its product row exists), `productKind` and `createdAt` are
added for predicates and ordering the admin list actually issues, and `productId` for the two batch
reads. The field-by-field difference is tabulated in the package README's "Two deviations from the
design's index table, both forced".

**† Coupons are keyed by id, with the code as a claim document.** `redeem`, `findById`, `update` and
`delete` are all handed an id, and the money path must not pay a lookup to reach the counter; the admin
list is keyset-ordered on `(createdAt, id)`, which is the host's own total order only when the document
id **is** that id. This record's own `uniqueIndexes` table already offered the alternative for
`coupons.code` — "the document id, or a claim document" — and the store took the second. Codes are
unique after case folding, where the SQL unique index was case-sensitive; `findByCode` stays
case-sensitive by comparing the code the claim stores. `coupon_redemptions` gains three indexes for
reads that exist: `createdAt` (the reconciliation sweep both ranges and orders on it), `redemptionId`
(`release` is handed the generated id, not the document id) and `holdsUse` — a **string** mirror of a
boolean, the same device as `publishKey`, because a refused key keeps a permanent document and that
document must stay out of the delete guard, `releaseByOrder` and the sweep. The redemption's state and
its lease are deliberately **not** indexed: nothing queries by them.

Two corrections against the plan's table. The `orders` customer index is `customerKey`, not `customerId`
(R3) — **† and, because a contract case pins the cross-customer buyer-reference edge, R3's conditional
fired: a second indexed `buyerRefLower` is declared alongside it, and the union is resolved as two merged
arms (§6).** And **`coupons` carries no `active` index** — the coupon table has no active or soft-delete
column at all, so declaring `active` would be a read contract for a field nothing writes. It does,
however, need **`createdAt`**: the admin coupon list is keyset-ordered on `(created_at, id)` with a
dedicated index behind it, and ordering by an undeclared field throws exactly as filtering on one does.
The list's only *filter* is a code search; its *ordering* is what `createdAt` serves.

**Idempotency is always a document id.** Every claim is `compareAndSet(id, null, …)`, a DB-level
`INSERT … ON CONFLICT DO NOTHING` enforced by the storage table's PRIMARY KEY on
`(plugin_id, collection, id)`. Four ledgers that were their own tables — cart mutations, coupon
redemptions, order notes and per-order events — collapse *inside* their aggregate document or become a
claim document of their own.

**The `uniqueIndexes` rule, stated so it matches the table above.** A unique index is declared where the
host's index sync would **benefit a read**, it is **never** the once-only enforcement, and it **may
coincide with the document id** — as it does for both rows that declare one, `sku_owners` and
`customer_emails`, whose natural key *is* their doc id. Declaring it there buys a lookup plan, not a
guarantee: the guarantee is the claim document and its create-if-absent write. It is worth being honest
about what that replaces, because today's SQL leans on database constraints as real backstops:

| Today's backstop | Replaced by |
|---|---|
| `reservations.idempotency_key` UNIQUE | the `reservation_keys/{key}` claim document |
| `orders.idempotency_key` UNIQUE | the `order_keys/{key}` claim document |
| `refunds.idempotency_key` UNIQUE | the refund's own key inside the order document, plus `refund_keys` |
| `coupon_redemptions (coupon_id, idempotency_key)` UNIQUE | `coupon_redemptions/{couponId}:{idempotencyKey}` as the doc id |
| `order_emails_outbox (order_id, to_state)` UNIQUE | first-wins entry inside the order document |
| `cart_lines (cart_id, sku)` UNIQUE | one line per sku inside the cart document |
| `order_notes.idempotency_key`, `entitlements.grant_idempotency_key`, `payments.provider_ref`, `payment_events.dedupe_key` UNIQUE | each becomes the document id of its claim |
| `product_commerce`/`product_variants` live-sku **partial** unique indexes | the `sku_owners` claim document (R4) |
| `customers.email`, `sessions.token_hash`, `coupons.code` UNIQUE | the document id, or a claim document |

One row of that table is a hazard rather than a translation. **`login_challenges` has no unique
constraint at all today** — its throttle is a count-then-insert with a genuine race window, and the
contract suite exercises the cap but not the race. The design **must not inherit that silently**:
whoever builds the identity adapters owns making the throttle a claim document (or recording
explicitly why it stays best-effort), rather than reproducing a count-then-insert on a store that
cannot even fall back to a constraint.

### 5. The index rule has two halves, and they are not the same half

**Declaration is a read contract.** A declared index is *required* to query or order by a field: an
undeclared field is not slow, it is a **runtime `StorageQueryError`** thrown by the where-clause and
order-by validators on every `query()` and `count()`. The adapter's own seam documents it as "a
programming error, not a runtime condition — the fix is to declare the index, which is why the declared
index lists are part of the read contract rather than a performance knob."

**What is actually pinned today, stated truthfully.** The built inventory tier shares **one exported
layout constant** between the store and its harness, so a collection's declared indexes and its test
harness cannot disagree — but **nothing pins the literal collection names or index lists**, because the
assertion and the subject are the same constant. And the deployed descriptor declares no storage at
all: the staging config test asserts `descriptor.storage` is **undefined**. So the list in §4 becomes a
pinned read contract only when the descriptor declares it, at the descriptor increment, whose
`site-config.test.ts` must assert the literal lists. What **is** tested today is the read contract
itself — that an undeclared field throws rather than silently scanning.

**Materialization is not a correctness guarantee.** The host's index sync logs per-index failures and
**never throws**, including for a unique index, so an index that fails to create degrades silently.
Worse, in both test tiers the index argument is only the queryable-field allow-list — the host's
index-materializing function is unexported, so **no tier creates a physical index and a `uniqueIndexes`
declaration enforces nothing there**. Hence the two-sided rule: **declare every queried field; never
let a unique index be the once-only enforcement.**

**Timing.** Hand-registered plugins have no install handler, so the once-per-process index sync on the
scheduler tick is their sync moment; with a minute-granularity cron declared, indexes appear within a
minute of deploy.

### 6. What the store cannot serve, and the decisions taken

`query({ where, orderBy, limit, cursor })` and `count(where)`. The filter supports exact match, null,
`in`, prefix and the four range comparisons — **no substring, no negation and no OR**: a flat record
joined with `AND` only.

1. **The orders-list search narrows to anchored prefixes. Ratified.** The old predicate is an OR of
   three arms, and an AND-only filter cannot express it in one query. The user-visible narrowing is on
   the **buyer-reference** arm: it stops matching mid-string. A domain (`example.com`), or any fragment
   that does not start the address, returns **nothing** — not an error and not a partial answer.
   **The narrowing will be documented in the screen's empty state at the lists/UI increment.** Widening
   the domain port instead remains available as a separate change with its own PR.

   **† Amended 2026-09-14 — how the three arms are actually served.** This clause originally said all
   three arms denormalize into **one** indexed field. They do not, and did not need to. As built they
   are three: `searchKey` (the folded order id, one `startsWith`), `buyerRefLower` (the folded buyer
   reference, one `startsWith`), and the `order_sku_index` pointer documents for the exact folded sku.
   The composite-key concern the original wording carried is therefore moot — a partial id matches a
   partial id and nothing else — and only the buyer-reference axis narrows. What makes three arms
   legitimate is item 3's cursor; see the merge ruling below.
2. **Correlated existence (search by line sku)** → `order_sku_index` documents, written after order
   creation, derived and idempotent (so needing no atomicity), healed on read and by the sweeper. **†
   They are a second query, not a contribution to `searchKey`**, and each carries a copy of the order's
   frozen `createdAt` so the arm is keyset-bounded rather than a full resolution of every order that
   ever bought the sku. Keying them by the `(sku, orderId)` **pair** is what makes "an order carrying
   two matching lines appears once" a property of the document id rather than a de-duplication step
   someone can forget.
3. **Keyset pagination maps in shape but not in token. † Decided 2026-09-14: re-derive.** The domain
   cursor is a value position; the host cursor is an opaque host-minted string whose seek re-reads the
   cursor row by id, so a deleted cursor row breaks it. The adapter therefore **ignores the host token
   and re-derives the position** from the port's own `OrderListCursor` (`{ createdAt, id }`): it seeks
   with a coarse range on the declared index and applies the exact `createdAt DESC, id DESC` tie-break
   in memory, because a true keyset tie-break needs an OR. A deleted cursor row is consequently **not a
   paging fault** — the position still describes itself and paging continues from it — and the case that
   pins it is written, where none existed anywhere in the tree before.

   **† The two-query merge is UPHELD, under one precondition.** The rejection below was written on the
   assumption of an opaque host-minted cursor, and item 3 retired that premise. The ruling, stated so
   the precondition travels with it: **an OR may be resolved as N indexed queries — each contributing
   its own top `limit + 1` — merged and re-sliced, and counted by inclusion–exclusion over the SAME
   predicate function, exactly when the cursor is a self-describing value position.** Both halves are
   load-bearing. The cursor is what makes "strictly after this position" decidable for a document from
   *any* arm, so each arm can be paged independently and the top `limit + 1` of the merge is the true
   page; the shared predicate function is what keeps the count from disagreeing with the page it
   captions. Under an opaque per-query token neither holds, and the rejection stands. Two ORs are
   resolved this way as built — the customer union (`customerKey` and `buyerRefLower`, counted by
   inclusion–exclusion) and the sku arm (counted as a set difference).

   **† The ordering invariant the merge needs, which is a one-dialect trap.** The adapter's total order
   is `createdAt DESC, id DESC` in **code-unit** order, because that is the order the port's cursor
   position is defined in. The host breaks its own `createdAt` ties on the id column under the
   *database's* collation, and one dialect's default collation ignores punctuation at the primary level,
   so host row order and code-unit order can disagree **inside a tie group**. The rule is therefore:
   **an arm is drained to the end of its boundary `createdAt` tie group before anything is sliced.**
   Truncating at the needed count in the host's row order lets a tied row fall off one page without
   appearing on the next — a silent gap, on one dialect only, which is exactly what the proving case
   observed when the drain was removed.
4. **`limit` is clamped by the host** (50 default, 100 ceiling), so reads that sum day documents page: a
   one-year reporting window is four pages, not one.
5. **No raw SQL and no host DB handle**, ever. Nothing in this design needs one.

### 7. The prose snapshot: what the old SQL guaranteed, and which document write guarantees it now

The Kysely stores are deleted at the service-removal increment. This section is where their guard
semantics survive. Predicates are quoted as predicates, never as line numbers. Where a proving suite
does not exist yet it says so.

#### 7.1 The guarded decrement — `WHERE on_hand >= qty`

*What the SQL guaranteed.* `UPDATE inventory SET on_hand = on_hand - :qty WHERE sku = :sku AND
on_hand >= :qty RETURNING on_hand` — read, compare and write in one statement, so two shoppers could
never both pass the comparison and `on_hand` could never go negative. Zero rows meant out of stock, not
an error.
*Invariant:* **no oversell** (an engineering invariant named for its test, not a product claim).
*Now guaranteed by:* one compare-and-set on `inventory/{sku}` in which the comparison is computed in JS
and the decremented count **and** the hold record commit together — the decrement and the record of who
applied it are the same atom.
*Proven by:* `inventoryStoreContract` on every dialect and `no-oversell.pg.test.ts` on Postgres — "N
concurrent reserves against M units yield exactly M winners", over 20 loops — the only tier that can
lose a real race.

#### 7.2 The claim flip — `WHERE state = 'pending'`

*What the SQL guaranteed.* The reservation was inserted `pending`, then flipped by
`UPDATE reservations SET state = 'held' WHERE id = :id AND state = 'pending'` in the same transaction as
the decrement. The guard elected exactly one caller to touch `on_hand`.
*What the loser did — corrected.* The loser did **not** roll back work it had done: the guarded update
matched zero rows, so the decrement never ran and the transaction returned its lost verdict having
performed **no writes at all**. The caller then **polled** the reservation row — up to 200 attempts at
5 ms — and **echoed the winner's answer**, throwing an **untyped** `Error` if the row never reached a
terminal state.
*Invariant:* **once-only** on the money path.
*Now guaranteed by:* the ordering rule — the terminal answer on `reservation_keys/{key}` is written
before the hold is pruned, and the hold is itself the record of application. The document model's loser
does not poll and echo; it **completes the claim** and derives the same answer from the durable record,
so a stalled winner cannot leave a caller spinning against a deadline.
*Proven by:* the crash-seam cases that park each write in turn — claim-written-nothing-else,
compare-and-set-ran-terminal-never-written, terminal-written-prune-never-ran — plus the
**prune-before-terminal** case, the only test of the ordering rule and the one a prune-first store would
fail.

#### 7.3 The adopt scope — `WHERE state = 'held' AND expires_at > :now`

*What the SQL guaranteed.* `UPDATE reservations SET state = 'adopted', order_id = :orderId WHERE
id = :id AND state = 'held' AND expires_at > :now` — a hold already eligible for the expiry sweep could
never be adopted, and a `NULL` deadline never satisfied the comparison, so an unstamped hold was not a
checkout hold.
*The read-back carve-out, without which a replay would be wrong.* When the flip matches zero rows the
store re-reads and returns success if `state = 'adopted' AND order_id = :orderId` — **with no
`expires_at` re-check at all**. Only the initial flip tests the deadline; the idempotent-replay path
deliberately does not, so a replay of an already-adopted hold succeeds **past** its stamped deadline.
Dropping that carve-out would lose a hold the order already owns.
*Invariant:* **no adoption of units that have already gone back on the shelf** (not exactly-once
expiry, which is the cart's guarantee in 7.7).
*Now guaranteed by:* the same predicate read off the hold inside the aggregate document, carve-out
included, with the null-deadline refusal preserved deliberately — the in-memory fake treats an unstamped
hold as adoptable and is the **outlier**; reconciling the fake is a follow-up.
*Proven by:* `inventoryStoreContract`'s "`adoptMany` replay is idempotent — a row already adopted for
THIS order stays adopted even PAST its hold deadline". Note the singular `adopt` carries the identical
carve-out and has **no test at all** — a gap the new adapter's suite should close.

#### 7.4 The batch classifications — `WHERE id IN (:ids)`

*What the SQL guaranteed.* Two methods took id sets — `adoptMany` flipping
`WHERE id IN (:ids) AND state = 'held' AND expires_at > :now`, `commitMany` flipping
`WHERE id IN (:ids) AND state IN ('held','adopted')` — so a whole batch was classified and applied
atomically, misses classified by a read-back. The unknown-id behaviours differed on purpose:
**`commitMany` throws `ReservationNotFoundError`** (matching the singular `commit`) **while `adoptMany`
folds an unknown id into `lost` and never throws**.
*Correction to the plan,* which described all four id-taking methods as `IN (:ids)`: only those two are.
`adopt` is single-id, and `releaseAdopted` is single-id **and order-scoped** — an order may only release
a hold it itself adopted — and is an unconditional no-op on any miss, never throwing.
*Invariant:* **once-only** per reservation; a paid order never left with an un-committed hold.
*Now guaranteed by:* N per-SKU compare-and-sets, each idempotent by reservation id, plus
`reservation_index` written before the hold, which is what makes "unknown" **provable** and so preserves
the asymmetry. Set-atomicity is replaced by the order document recording the intent first and a sweeper
completing a partial.
*Proven by:* the contract's batch cases including the unknown-id asymmetry and "commitMany partial: a
released hold is lost; an already-committed hold is benign; a held hold commits"; the multi-line checkout
race across 3 SKUs, which asserts a batch never oversells **or half-commits**; and the partial-batch
crash seam.

#### 7.5 The refund ceiling — `min(Σ captured, frozen total)` under a row lock

*What the SQL guaranteed.* The order row was locked, the succeeded payments summed, the ceiling taken as
`min(captured, frozen total)`, and the refund arbitrated and inserted inside the same lock, so two
concurrent refunds could not each read the same headroom.
*What the lock actually was — corrected.* Not `FOR UPDATE`, which the SQLite dialect does not offer, and
**not** a self-assignment either: it is
`UPDATE orders SET updated_at = :now WHERE id = :orderId RETURNING id, state` — a **real column write**,
so every refund attempt genuinely bumps `updated_at`. On Postgres the row lock serializes concurrent
refunds; on SQLite writes serialize globally and it is a harmless no-op. The self-assignment trick
(`on_hand = on_hand`, `product_id = product_id`) and the "`FOR UPDATE` is not SQLite" rationale live in
the **product-commerce** store, not here.
*Invariant:* **the ceiling is never exceeded**; refund once-only.
*Now guaranteed by:* `payments[]` and `refunds[]` embedded in the order document with the active sum,
the arbitration and the insert all inside one compare-and-set — the revision check does what the row
lock did. `refund_keys/{refundKey} → orderId` exists because the settle path holds only the refund key
and an embedded array cannot be found by it without a scan. The four-state capacity lifecycle is R6.
*Proven by:* `refund-order-contract` — the short-capture case binding the ceiling at captured, the
over-refund past the frozen total recording nothing, repeated partials summing to the ceiling, and the
three R6 cases — plus `refund-race.pg.test.ts`, where N concurrent full refunds yield exactly one winner
and N concurrent partials stay sum-bounded under every interleaving.

#### 7.6 The sku rename — two inventory rows locked in sorted order

*What the SQL guaranteed.* Carrying stock from an old sku to a new one locked **both** inventory rows —
acquired as a pair, iterating the two skus in **sorted order**, so every writer agreed on one lock order
and two crossing renames could not deadlock (measured at roughly one loop in 250 before the sort
existed). Each lock was a portable self-assignment `UPDATE`. It then claimed the target row
(`ON CONFLICT (sku) DO NOTHING`, raising `SkuStockConflictError` if the claim was lost), moved the units,
wrote paired `rename_out`/`rename_in` ledger rows whose own conflict clause can never fail the move, and
short-circuited entirely for a sku that was never stocked. It refused the whole operation with
`SkuHeldStockError`, naming the sku and the count, if
`SELECT count(*) FROM reservations WHERE sku = :source AND state IN ('held','adopted')` was non-zero.
The avoidance was **not complete**, and was recorded as such: the product-side writers take a
unique-index lock before any inventory lock, so two products renaming onto each other's skus could still
deadlock, and a lock-order deadlock was never mapped to a typed error.
*Invariant:* **stock conservation** across a rename; no rename out from under a live hold.
*Now guaranteed by:* the intent-claim of §3 — source zeroed and stamped, target applying once by token,
source clearing. A fixed lock order is replaced by a fixed step order, and there is no lock to order —
which also retires the residual deadlock above.
*† The held-stock refusal is NOT structural, and that is an accepted weakening — corrected 2026-09-14.*
The clause this replaces claimed the refusal "becomes structural, because the holds it checks are in the
very document being written". It is not, because the ratified step order is **carry after the product
write**: the product's own document commits first, and only then does the move run. So a reservation
landing in that window leaves the rename **committed with the carry owed**, where the SQL — which
locked the source row before it counted holds — would have refused the whole operation atomically. What
an observer sees is a product whose sku is the new one while its stock is still under the old one: a
**phantom out-of-stock on the target, never an oversell**, because no unit is ever counted twice and the
source's units stay exactly where a release of that hold expects them. The source sku's claim is held
until the carry is terminal, so nobody else can take those units meanwhile, and a new rename of the same
owner is refused with the same `SkuHeldStockError` until it completes. Completion is not deferred to a
sweeper alone: **any later write on the product runs it first**, and the sweeper is the backstop. One
consequence worth stating because an auditor will look for it — **which route completed the carry decides
whether the audit trail is whole.** A completion driven from the product's own recorded intent, which is
what a later product write and the product-side sweeper leg both do, moves the units *and* writes the
paired `rename_out`/`rename_in` entries, because the recorded intent carries the command key they are
derived from. A completion driven from the **inventory document's stamp** — the replayer's and the
inventory sweeper leg's entry point — has no command key, so it deliberately writes **no pair** rather
than invent entries it cannot attribute. The trail can therefore be honestly incomplete for a rename that
crashed mid-flight, and only for that. The contract pins the sequential refusal, which is unchanged; the
window is reachable only by a concurrent reserve and the adapter's crash-seam suite drives it
deliberately. The package README's "What the carry cannot make atomic, stated exactly" is the full
statement.
*Proven by:* `product-commerce-store-contract`'s refusal cases at both grains, `sku-rename-ledger`, and
`sku-rename-race`/`variant-sku-rename-race` — including the crossing-renames case where one side refuses
typed and neither deadlocks, satisfied on documents by there being no lock at all.

#### 7.7 The cart hold expiry transaction

*What the SQL guaranteed.* One transaction re-checked the deadline, returned the units and deleted the
line, so a line could never be deleted without its units coming back. The re-check was the flip's own
guard: `state = 'held'` **and** either a stamped deadline at or before now, **or** an unstamped hold
older than the cutoff **that also has a cart-mutation ledger row** — an existence test which is what kept
the cart sweep from reaping a hold no cart created. Only the flip winner incremented `on_hand` and
deleted the line. *Invariant:* **exactly-once expiry.** *Now guaranteed by:* the intent-claim — a guarded
flip of the line to `expiring` (the once-only token), then the release, then the removal, with a sweeper
completing a partial. The null-deadline arm's scoping survives as a property of the cart document that
owns the line: a hold with no cart line is not the cart sweep's to reap. **†** One thing to be exact
about, because the SQL's guard was a single predicate and this is two steps: the indexed `holdExpiresAt`
is only a **candidate filter**, a deliberate **superset**, and both of the SQL's arms — the stamped
deadline at or before now, and the unstamped hold older than the cutoff that also has a mutation record —
are **re-applied per fetched document** before anything is reaped. The index narrows; it does not decide.
Checkout keeps the shape it already has — a single guarded flip whose `state = 'active'` predicate is
itself the write-once, so a replay reports "already done" rather than failing. *Proven by:*
`cart-store-contract`/`hold-expiry`, whose cases are the specification here — an expired hold is released
and its stock returns, a lazy read racing the sweep returns stock **exactly once**, a hold whose TTL was
reset between listing and release is not reaped, a non-cart hold older than the TTL is not reaped — plus
`cart-fence` and `no-oversell-cart.pg.test.ts`.

#### 7.8 The coupon guard — `uses_count + 1 WHERE max_uses IS NULL OR uses_count < max_uses`

*What the SQL guaranteed.* One statement incremented the counter only while headroom remained; zero rows
meant exhausted. The `OR` made an uncapped coupon unconditional in the same statement. The per-customer
cap was then checked **after** that bump, in the same transaction, by **counting** the customer's
redemption rows — race-free because the coupon-row update had already taken the row lock — and its
refusal was undone by **rolling the transaction back**, so a per-customer rejection consumed no global
headroom. *Invariant:* **no over-redeem**, and no global headroom consumed by a per-customer refusal.
*Now guaranteed by:* R1's inverted order plus an idempotent compensation, because there is no rollback.
**†** The statement above that the counter's guard is "one statement" survives exactly, and deliberately:
as built the `updateIf` guards the cap **and nothing else**, because once-only lives in the redemption
key document's `claimed → bumping → applied | refused` state instead (amended R1). The uncapped case is a
plain delta for the same reason the SQL's `OR` made it unconditional — an uncapped coupon has no
invariant to violate. *† Two divergences from the SQL, both narrowings, both recorded rather than
discovered.* First, **a refusal is recorded permanently**: a replay of an exhausted key answers exhausted
again even if headroom has since been released, where the SQL rolled its refusal back and kept no record
so a retry there could later succeed. A stable answer per idempotency key is the property the whole
document model rests on. Second, **the per-customer counter document exists only while a cap is in
force**, so adding or raising a cap later counts only the redemptions made while a cap was set — the SQL
counted rows and had no such window. The alternative, a per-customer index over the redemption documents,
was weighed and the bounded document preferred. *Proven by:* `coupon-store-contract`/`coupon-lifecycle` —
the per-customer cap case, the guest-checkout degradation case, and the same-key replay — and
`coupon-no-over-redeem.pg.test.ts`, where N concurrent redeems at cap M leave exactly M successes and two
same-customer concurrent redeems at a per-customer cap of 1 leave exactly one; **†** plus the same-key
shapes that pin the state machine — 20 completers of one key while 20 peer keys commit, capped and
uncapped — and the crash seam that pins the lease from the forbidden side, with the owner's increment
parked.

#### 7.9 Order creation — `ON CONFLICT DO NOTHING` plus the snapshot inserts

*What the SQL guaranteed.* The header was inserted with `ON CONFLICT (idempotency_key) DO NOTHING`.
*Corrected:* a returning-nothing insert did **not** short-circuit the whole call — the transaction body
returned its "not created" verdict, skipping every follow-on insert, and the caller then **loaded the
existing order by the idempotency key** and returned it as not-created. Also corrected: only
`order_items` is **multi-row**, and it is skipped entirely when the line array is empty; `order_totals`
and the shipping address are **single-row**, the address conditional on one having been captured. The
totals row is 1:1 by construction — `order_id` is the **primary key** of the totals table, so a second
insert is a key violation rather than a convention.
*Invariant:* **replay once-only** and **snapshot immutability** — price and title frozen at purchase, so
editing a product never rewrites an existing order's line items.
*Now guaranteed by:* one order document created by create-if-absent carrying header, items, totals and
address together, with `order_keys/{idempotencyKey}` claimed first and carrying the full intent so any
replayer can finish the create deterministically. Snapshot immutability becomes **structural**: the items
array is written only by the creating write and is typed `readonly`, and one-totals-per-order is
tautological once totals are a field.
*Proven by:* `order-store-contract` — "replay with the same idempotency_key returns the same order
(created:false)" and "a replay carries the shipping address exactly once (idempotent snapshot)" —
`order-flow.dialects.test.ts`, and the existing case asserting that editing a product never rewrites an
order line.

#### 7.10 The transition — guarded flip plus event append plus outbox insert

*What the SQL guaranteed.* One transaction flipped the state guarded on `id = :orderId AND
state = :fromState`, some callers adding a `hold_expires_at <= :before` predicate; then — **only if the
flip won**, a zero-row flip returning immediately — appended an event row with **no conflict clause at
all**, and inserted the outbox row with `ON CONFLICT (order_id, to_state) DO NOTHING`, itself gated on
the caller asking for an email.
*Correction to the plan,* which called the outbox write an upsert: it is a do-nothing conflict, so the
first enqueue for a target state wins and later ones are no-ops.
*Invariant:* **transition once-only**, **audit completeness**, outbox exactly-once per (order, target
state).
*Now guaranteed by:* ONE compare-and-set on the order document guarded on the revision **and** on the
current state being the expected from-state, writing the new state, the appended event and the
first-wins outbox entry together. "Flipped but no event" is structurally unreachable, as it already was.
*Proven by:* `order-transition-contract`, `order-timeline-contract`, `outbox-dispatch`.

#### 7.11 The orders-list search — an OR of three arms, and why a join would double-count

*What the SQL guaranteed.* A folded id-**prefix** arm **OR** a folded buyer-reference **substring** arm
**OR** an **exact** folded line-sku arm expressed as a correlated `EXISTS` over the order's own frozen
lines. The port states why the sku arm is an existence test and never a join: the list's contract is
**one row per order**, and an order with two matching lines must appear once — a join would return it
twice, inflate the `limit + 1` next-page probe, and make the count that captions the page over-count,
since the count shares the predicate. The two dialects planned the arm oppositely — one de-correlating it
into a hashed subplan, the other keeping it correlated — both confirmed by reading the query plan rather
than assumed. The sku matched is the one frozen onto the lines at purchase time, so a rename leaves
earlier orders findable under the sku they were bought as. Alongside it, the **customer** filter was its
own OR (`customer_id = :id OR lower(buyer_ref) = lower(:ref)`, folded JS-side), and the date filter was
half-open: `created_at >= :from AND created_at < :to`.
*Invariant:* **one row per order**, and the count agreeing with the page it captions.
*Now guaranteed by:* **† corrected 2026-09-14, because the lists adapter resolved this differently and
better.** Three indexed arms, merged, not one denormalized field: an anchored `startsWith` on
`searchKey` (the folded order id), an anchored `startsWith` on `buyerRefLower` (the folded buyer
reference — the one axis that narrows), and the `order_sku_index` pointers for the exact folded sku,
still derived from the **frozen** lines. One row per order survives twice over: the pointer's id is the
`(sku, orderId)` pair, so an order with two matching lines owns exactly one, and the count adds the sku
set as a **set difference** over the same predicate function rather than a second tally. The **customer**
half also remains a union and also became two arms rather than one `in` clause: R3's conditional fired
because a contract case pins the cross-customer edge — an order owned by one customer id whose buyer
reference folds to the queried reference — so `customerKey` and `buyerRefLower` are queried separately
and counted by **inclusion–exclusion**, which is what keeps an order matching both halves counted once.
§6.3 records the precondition all of this rests on: a self-describing value-position cursor. The
half-open window needs no denormalization at all: `gte` and `lt` express it directly.
*Proven by:* the list and count cases in `order-store-contract` on every tier, ADR-0017's refresh cases,
and a one-row-per-order case under a multi-line sku match. **†** The **deleted-cursor-row case is now
written**, and so is the four-order tie-group case that pins the §6.3 drain — the one case that fails on
a single dialect if the drain is removed. The store's own narrower statement, that a mid-string
buyer-reference fragment finds nothing, is pinned in its package tests rather than in the shared
contract, which deliberately asserts only the anchored floor so an adapter serving the unanchored
superset stays conformant.

#### 7.12 Inventory store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `commit`: flip `WHERE id = :id AND state IN ('held','adopted')`; on zero rows re-read and return if already `committed`, else raise `ReservationCommitLostError` (or `ReservationNotFoundError` when no row exists) | commit once-only; a hold that is not live can never be silently committed | the reservation's terminal state in `reservation_index` plus the live hold in the aggregate; both typed errors preserved | `inventoryStoreContract` for the batch path. The singular commit-lost throw has **no case in the shared contract file**, but it *is* asserted twice outside it — `order-flow.dialects.test.ts` ("commit against a released reservation throws the loud `ReservationCommitLostError`; against a committed one it is a benign no-op") on every dialect, and the document adapter's own crash-seam suite, which asserts the same class for an orphaned index entry. Folding a case into the shared contract remains worthwhile |
| `release`: `released` returns; any other non-live state throws an **untyped** `Error`; a lost flip inside the transaction is a **silent no-op** | stock returns exactly once | the same two reads, and a lost settle is still a silent no-op. **†** The throw is now **typed** — the adapter's `ReservationNotReleasableError`, naming the reservation and the state found — because the cart expiry deliberately swallows this case and must not do so by matching a message (§2) | `inventoryStoreContract` "commit finalizes; release returns stock; double-commit and double-release are no-ops"; "release(unknownId) rejects with ReservationNotFoundError" |
| `#applyStockMovement`: ledger claim `ON CONFLICT (idempotency_key) DO NOTHING`, then an unconditional increment (restock) or a guarded `on_hand >= qty` decrement (removal) | stock conservation; movement once-only | the `inventory_movements/{prefixedKey}` claim plus one compare-and-set on the aggregate, with the ring as the in-flight witness | `inventoryStoreContract`; `restock-concurrency.pg.test.ts` |
| the **key-consumption asymmetry**: an unknown sku throws inside the transaction, so claim and movement both roll back and **the key is NOT consumed**; a genuine `INSUFFICIENT_STOCK` is recorded in the ledger **inside the committing transaction**, so the key **IS** consumed | a refusal that is a fact about the sku is retryable; a refusal that is a fact about the stock is final | the document model reproduces it by ordering: the unknown-sku case exits **before** the claim is written, the insufficient-stock case writes the claim's recorded answer | `inventoryStoreContract` "unknown-sku reserve is OUTSIDE idempotency scope: the key is not consumed and stays usable once the sku exists" |
| `StockMovementMismatchError` when a movement key is replayed with a different sku, direction or qty | one key means one movement | the claim document carries the full intent, so the comparison is a read of the same document | `inventoryStoreContract` "a stock-movement key reused for a different movement is rejected, never ok for the wrong movement" |
| `adjust` guard 1: the ledger's recorded reservation id must equal the caller's, else `AdjustReservationMismatchError` | one adjust key means one hold | the same comparison against the claim document | `inventoryStoreContract` "an adjust key replayed against a different reservation is rejected, never ok for the wrong hold" |
| `adjust` guard 2: the reservation must be `held`, else `ReservationNotHeldError` (or `ReservationNotFoundError` for an unknown id) | an adjust never moves a hold that is no longer the caller's | read off the hold in the aggregate and the index's terminal state | `inventoryStoreContract` |
| `adjust` guard 3: the qty CAS `WHERE id = :id AND state = 'held' AND qty = :prevQty`; a lost CAS aborted the transaction, and the **whole choreography re-ran**, re-reading the ledger and the reservation rather than re-deriving in place | an adjust and a concurrent checkout on one hold serialize | **the inventory document's revision is the replacement guard (§3, R5)**: a checkout-side hold change bumps the revision, so a concurrent adjust's compare-and-set loses and re-reads, and the completion then applies the absolute target against the hold's **current** qty. Outcomes stay the port's own — `ok`, a genuine `OUT_OF_STOCK`, or the typed mismatch/not-held/not-found errors — **plus `StorageContentionError` on an exhausted budget, which the port does not document** (see §2: a docs-only `[Domain]` follow-up, not changed here) | `adjust-concurrency.pg.test.ts`, re-pointed at the document adapter |
| `reserve`'s FK carve-out: an unseeded sku aborted the insert on the foreign key, so **no row and no key** were written | an unseeded sku is a pre-claim rejection, outside idempotency scope | step 2 of §2 — an absent inventory document returns `OUT_OF_STOCK` and claims nothing | as above |
| `reserve`'s real once-only: `ON CONFLICT (idempotency_key) DO NOTHING` over a UNIQUE constraint | replay once-only | `reservation_keys/{key}` create-if-absent over the storage table's primary key | `inventoryStoreContract` replay cases |

#### 7.13 Order store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `claimNextEmail`: `sent_at IS NULL AND status != 'failed' AND (lease_until IS NULL OR lease_until <= :now)`, claimed by re-applying the same predicate and setting `status='sending'`, a caller-supplied `lease_until` and `attempts + 1` | a message is sent once; a crashed dispatcher's row becomes claimable again | **† corrected 2026-09-14:** R2's single `emailDueAt` field as the **candidate filter**, with the predicate re-applied to the fetched document and the claim taken by a **revision `compareAndSet`** on the order document — not the `updateIf` R2 first promised (see R2) | `outbox-dispatch` "a crashed dispatcher run leaves the row claimable again after its lease expires"; "a failed send returns the row to pending; the next dispatch delivers it exactly once" |
| **†** *(new 2026-09-14 — no SQL analogue)* settling an outbox entry by **entry id alone** | a message settled once; a lost locator never reads as "already drained" | `outbox_keys/{entryId} → orderId`, written **after** the flip that enqueued the entry, so the only reachable tear is "entry exists, locator does not" — which the settle path **heals** with one bounded walk of the `emailDueAt` index and then writes the locator so the next settle is a single read. The reverse ordering would leave a locator pointing at nothing, which nothing could heal. A walk that still finds nothing is **loud**, not quiet: an already-drained entry HAS a locator and never reaches the walk, so an unresolvable id means a live lease about to lapse and a second send — it raises the typed retryable `OutboxEntryUnlocatableError`, having written nothing. `maxOutboxPages` bounds the fallback **only**, and is a separate knob from `maxExpiryPages` on purpose: the two scans are bounded by different things, so squeezing one must not silently squeeze the other | the order crash-seam suite's locator cases |
| **†** *(new 2026-09-14 — no SQL analogue)* `recordPayment`'s provider reference, **globally** | one provider reference means one payment, across **all** orders | `payment_refs/{providerRef} → orderId`, create-if-absent. The SQL's `ON CONFLICT (provider_ref) DO NOTHING` was per-table and **silent**; this throws `PaymentRefConflictError` when the reference is already claimed by **another** order, and a payment against a missing order throws a typed not-found. That is a deliberate loudening, and it has a consumer obligation: the settle path must map it to a **non-retryable acknowledgement plus an anomaly**, or a gateway retries forever | the order store's payment-reference cases |
| **†** *(new 2026-09-14 — no SQL analogue)* cancellation releases the order's **adopted** holds | a cancelled order does not strand its holds; a **paid** order's spent units are never returned | The SQL's cancel was a pure envelope write, and the expiry sweep scans only `pending`, so a cancelled `pending` order strands its holds forever. The `→ cancelled` flip therefore records the same `holdsReleased` intent the `→ expired` flip does, state-guarded, and the release is completed idempotently by any replayer. What makes that safe on a **paid** order cancelled after settle is the inventory store's **`adopted`-only** guard on `releaseAdopted`: a `committed` hold is not adopted, so the release is an unconditional no-op, `onHand` is unchanged and spent units are never put back. That guard is load-bearing here, not incidental | the shared paid-cancellation case, registered on every dialect |
| `resolveReconciliation`: compare-and-clear — sets the disposition and nulls the flag `WHERE id = :id AND reconciliation_flag = :expectedFlag` | a resolution never clobbers an anomaly re-raised since the operator read it | the same comparison inside the order document's compare-and-set, where the revision adds a second guard | `order-store-contract` "resolveReconciliation with a STALE expectedFlag is a 0-row miss: the re-flagged anomaly survives"; the non-flagged and once-only cases |
| `flagReconciliation`: unguarded, **last-writer-wins** | an anomaly is always recordable | preserved as last-writer-wins on the field; it is deliberately not a CAS | `resolve-reconciliation-race.pg.test.ts` |
| `recordPayment`: `ON CONFLICT (provider_ref) DO NOTHING` | a gateway redelivery records one payment | the provider reference keys the entry inside `payments[]`; a present key is a no-op — **†** and, for a reference already claimed by a **different** order, the new `payment_refs` row above | `refund-order-contract` captured-sum cases |
| `voidRefund` / `markRefundUnverified`: guarded flips out of `status = 'reserved'` | capacity is released or held deliberately, never by accident | R6, inside the order document's compare-and-set | the three `refund-order-contract` cases named in R6 |
| `order_totals.order_id` as PRIMARY KEY | one totals row per order | tautological once totals are a field of the order document | `order-store-contract` |
| `linkGuestOrders`: `WHERE lower(buyer_ref) = :folded AND customer_id IS NULL` | a guest's orders attach to exactly one account and never re-attach | the same predicate, **plus rewriting `customerKey`** (R3) so the customer filter keeps working afterwards | `order-transition-contract`'s guest-linking cases — the two-customer case, and "linkGuestOrders matches buyer_ref case-insensitively — a mixed-case guest checkout still links", whose second call returning 0 pins the no-re-attach half. (`order-store-contract` never calls `linkGuestOrders`) |

#### 7.14 Cart store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| the mutation ledger: claim `ON CONFLICT (idempotency_key) DO NOTHING`, complete by upserting `completed = 1` with the resulting line and qty, and **short-circuit a replay by reading the recorded result inside the transaction before any work** | a retried cart mutation never re-does inventory-affecting work | the mutation map embedded in the cart document, read and written in the same compare-and-set. **†** Two additions the port signatures force: the map is **bounded** at 64 *completed* records — a claimed-but-incomplete record is never pruned, so a bound can never eat an unfinished intent — and a second collection `cart_mutation_index/{idempotencyKey} → { cartId }` exists purely as a **locator**, because `recordedMutation(key)` and `expireHold(reservationId)` are handed no cart id and an embedded map cannot be found from a key alone. It is the `reservation_index` device again (§4) | `cart-store-contract` "add is idempotent…", "increase is idempotent…", "adjust replay after an intervening different-key adjust is a no-op returning the recorded result and moves no stock" |
| `upsertLine`'s hold stamp: `UPDATE reservations SET expires_at = :deadline WHERE id = :id AND state = 'held'`; zero rows raises `HoldExpiredError`. (It stamps the deadline; `state='held'` is a **precondition**, not something it sets) | a line is never visible attached to a hold that is no longer live | **† corrected 2026-09-14.** It stays a guarded **write**, not a read. This row previously said the attach guard "becomes a read of the hold before the cart document is written"; that is wrong, and would have been a TOCTOU — between the read and the cart write the sweep can reap the hold and the line is resurrected anyway. The port's docblock is explicit that the deadline stamp *is* the attach guard, so the capability is declared adapter-locally (`HoldDeadlineStamper.stampHoldDeadline`, asked for by the cart store's constructor as `InventoryStore & HoldDeadlineStamper`) and is one guarded read-modify-write on the inventory aggregate in which the `held` precondition, the ownership check and the new deadline commit together. `true` is durable proof the hold was live at the instant of the write; `false` — never a throw — is an unknown, pruned or no-longer-`held` hold, and the cart store turns it into `HoldExpiredError`. `expiresAt` is non-null by type, because a hold stamped with no deadline could never be adopted. **No port was widened and no mandated write was dropped**; the order store must not re-stamp | Still **no case in the shared contract file**; the outcome was driven through the real Kysely adapter on every dialect by `reserve-cart-line-crash.dialects.test.ts` ("a late add replay after the sweep reaped its crashed hold does not resurrect a line"), which asserts the use-case's `HOLD_EXPIRED` reason rather than the class. **†** The cart store adds the store-level regression case the stamper needs — a stamped line whose hold is then adopted by `adoptMany` |
| `(cart_id, sku)` unique upsert with a do-update conflict clause | one line per sku per cart | the lines map keyed by sku inside the cart document | `cart-store-contract` |
| `adjustLine`'s correlated subselect: when a reservation exists the stored line qty is taken from the reservation's own qty rather than the caller's | the line qty and the hold qty can never diverge | one document write derives the line qty from the hold it just read. **†** It also gained a **reconcile pass with no SQL analogue**: the SQL could lean on the subselect running inside the same transaction as the write, and there is no such transaction here, so convergence is made *provable* rather than assumed — the line is re-derived from the hold on a later pass if the two ever disagree | `cart-store-contract` "increase delta-reserves the difference"; "decrease partial-releases and always succeeds" |

#### 7.15 Coupon store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `delete … WHERE NOT EXISTS (SELECT … FROM coupon_redemptions WHERE coupon_id = coupons.id)`, returning a typed `in_use_by_redemptions` **result** rather than throwing | a coupon with history is never deleted out from under it | a count of the coupon's redemption documents read before the delete, with the same typed result | `coupon-store-contract` "delete is forbidden while a redemption references the coupon (in_use_by_redemptions)"; "delete becomes possible once the redemption is released" |
| `release` / `releaseByOrder`: `uses_count - 1 WHERE uses_count > 0` — a **predicate guard**, so the counter never goes negative and a release at zero simply matches nothing | the counter never goes negative; release is idempotent | `updateIf` with the mirror-image guard `usesCount > 0` — **†** one of the package's **two** `updateIf` sites, and the only decrement among them; both guard the same field of the same document, which is what makes the lock-free path safe here and nowhere else (§1). Its residual is **one HIGH, never one LOW** | `coupon-store-contract` "releaseCoupon on an already-released or never-redeemed id is a no-op, not an error"; "releaseByOrder … decrements uses_count, and is idempotent" |

#### 7.16 Product-commerce store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `upsert`'s dual guard: `idempotency_key != :key` **and** an incoming CMS watermark that is null-or-not-older | a same-key replay and a strictly-older CMS delivery are both no-ops | both comparisons read off the same document inside its compare-and-set | `product-commerce-store-contract` "upsert replayed with the SAME idempotencyKey as the stored row is a no-op…" |
| `updateCommerceFields`/`updateVariantFields`: CAS `WHERE product_id = :id AND deleted_at IS NULL AND updated_at = :expected AND idempotency_key != :key`, and a **zero-row classifier whose order is load-bearing**: not-found (or soft-deleted) → same-key replay returns ok → `stale` → the currency mismatches | an operator never silently overwrites a newer edit, and the reason they are shown is the most specific true one | the same fields and the **same classifier order** inside one compare-and-set, with the document revision as a second, cheaper staleness check | `product-commerce-store-contract` "a same-key replay AFTER the row was soft-deleted is not_found…" |
| `activate`/`deactivate`: `WHERE deleted_at IS NULL AND active = :from AND (active_updated_at IS NULL OR active_updated_at <= :watermark)` | an out-of-order publish cannot re-latch a newer transition; a soft-deleted row never resurrects | the same watermark comparison in the document | `product-commerce-store-contract` "out-of-order: deactivate@T2 (newer) then a STALE activate@T1 (older)…" |
| `softDelete`: sets the tombstone `WHERE deleted_at IS NULL`, leaving the sku column intact — which **releases** the sku, because live-sku uniqueness is partial over non-deleted rows | delete is always a tombstone; the sku becomes reusable at once | the tombstone field plus **releasing the `sku_owners` claim** (R4), which is what makes the release explicit rather than a side effect of an index predicate | `product-commerce-store-contract` "softDelete sets deletedAt + active=false and retains the row (never a hard delete)" |
| `upsertVariant`: `ON CONFLICT (product_id, variant_key) DO NOTHING`, plus a resurrect path gated on the row being orphaned **and** the incoming watermark being strictly newer | the variant key is the immutable identity; a re-declare never mints a second row; revival needs a strictly-newer delivery | the variants map keyed by variant key inside the product document, same gate | `product-commerce-store-contract` "upsertVariant RESURRECTS an orphaned variant…" |
| the two **partial** unique indexes (`unique … WHERE deleted_at IS NULL` and `unique … WHERE orphaned_at IS NULL`) plus the **reciprocal** cross-grain checks, with `SkuConflictError` outranking `SkuStockConflictError` because the cross-table check runs first | one live owner per sku across products and variants, and the operator is told the more fundamental reason | R4's `sku_owners` claim document, with the precedence preserved by checking the claim before the stock. **†** The claim is a **lease**, so holding it is not enough: its revision is re-asserted by a heartbeat compare-and-set immediately before every applying sku-bearing write, on every retry, and an overtaken writer is refused `SkuConflictError` — one extra write per applying write, which is the ratified price of not letting a parked writer land two live rows on one sku (amended R4) | `product-commerce-store-contract` "PRECEDENCE: a product rename onto a sku a LIVE VARIANT holds refuses as SkuConflictError, never as a stock conflict"; `variant-sku-rename-race.pg.test.ts` |

#### 7.17 Identity, entitlements, settings, rules, ledgers and reporting

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| **†** settings `update`: read the recorded mutation and return it if present, else claim `ON CONFLICT (idempotency_key) DO NOTHING` and apply, both inside one transaction | a replayed settings key returns the recorded result and never re-applies the patch — and a stale replay never clobbers a newer update | `settings_mutations/{key}` as a claim document carrying the PATCH and the settings revision it was decided against; the result is stamped onto it once, after the write lands. So a replay returns the landed result; a claim that never landed may be completed by a non-creator **only** by a compare-and-set at that recorded revision — or, where the merge changes nothing, by stamping the result with no settings write at all, which is how a mutation whose own write landed and whose stamp was lost completes — and past it is refused as superseded rather than re-merged. There was no transaction to inherit, so the pin is what the transaction used to be | `settings-store-contract` "update replayed with the same idempotencyKey returns the recorded result and does not re-apply", plus the adapter seams "a crash between the mutation claim and the settings write is completed by the replay" and "an un-landed mutation overtaken by a newer update never clobbers it and is never double-applied" |
| entitlement `grant`: `ON CONFLICT (grant_idempotency_key) DO NOTHING`, then re-select and return the original | a grant is issued once | the grant key **is** the document id | `entitlement-store-contract` "grant is idempotent under grantIdempotencyKey — a replay grants once" |
| **†** entitlement `check`: **a query with neither an order nor a buyer reference is refused** | an **authorization boundary** — delivery must be scoped, and an unscoped check must never be a wildcard pass (ADR-0011) | a typed `EntitlementScopeRequiredError`, raised before any read — LOUDER than the SQL's `false`, which is a divergence in loudness and never in outcome (both fail closed, and nothing is served on either path) | `entitlement-store-contract`, plus the adapter case "a scopeless delivery check is refused with a typed error, and authorizes nothing", which is what now names the empty-scope branch |
| address `update`/`delete`: `WHERE id = :addressId AND customer_id = :customerId` on **both** | **cross-customer isolation** — a security invariant, not a convenience | an **explicit ownership check** on the address inside the customer's own document, since a document id alone carries no owner. This must be written as a check, not inherited from a key shape | `address-book-contract` "update is customer-scoped: B cannot touch A's address (returns null)"; "delete is customer-scoped: B cannot delete A's address" |
| session `validate`: `WHERE token_hash = :hash AND revoked_at IS NULL AND expires_at > :now`; `revoke`: guarded on `revoked_at IS NULL` | only a live, unexpired, unrevoked token authenticates; revoke is idempotent | the token hash is the document id; the two other clauses are field reads | `session-contract` "a revoked token no longer validates"; "an expired token no longer validates" |
| credential `verifyChallenge`: single-use consume `SET consumed_at = :now WHERE id = :id AND consumed_at IS NULL`; zero rows is the `CONSUMED` answer | a magic link works exactly once | a compare-and-set on the challenge document guarded on the consumed field being absent | `credential-verifier-contract` "verifyChallenge with an already-consumed token returns CONSUMED…" |
| `issueChallenge`'s throttle: **count-then-insert, not transactional, over a table with no unique constraint** — a genuine race | rate limiting | **must not be inherited silently.** The identity increment owns making the throttle a claim document, or recording why it stays best-effort | the cap is tested ("rapid repeat requests hit the per-email cap…"); **the race is not**, and a case must be written |
| shipping `deleteZone` / tax `deleteClass`: `NOT EXISTS` over children, returning typed `in_use_by_methods` / `in_use_by_rates` results | a zone or class with children is never deleted out from under them | children embedded in the parent document make the check a read of the same document | `shipping-rules-store-contract` "deleteZone is forbidden while a method still references it (in_use_by_methods)"; the tax twin |
| `updateRate` / `updateTaxRate`: money CAS on `amount_cents = :expected` / `rate_bps = :expected`, misses classified `not_found` vs `stale` | a rate edit never silently overwrites a concurrent one | the same expected-value comparison inside the zone or class document's compare-and-set. **†** One consequence the SQL did not have: the value lives in a document that also holds the parent's name and its other children, so **unrelated writes contend for one revision**. A lost revision race is therefore retried by **re-reading and re-comparing**, never by re-submitting the decision — a caller that lost a real edit race is told `stale` on its next attempt instead of overwriting the change it should have seen. A wrong shipping fee or tax rate is money | `rules-stores-contract`, `rules-cas-race.pg.test.ts` |
| **†** *(new 2026-09-14)* `updateZone` / `updateMethod` / `updateClass` — the **rename** edits, which the ports document with no `stale` outcome | a rename is always recordable | preserved as **last-writer-wins**: there is no business-rule refusal, so every writer of the document eventually commits. It is still written as a read-modify-write compare-and-set rather than a blind put, because the parent's children share the document and a blind put would delete a concurrently created method or rate. These are the **one exception** to "the retry bound is a property of the document": with no guard to refuse anybody, depth grows with the **crowd** rather than with the invariant | `rules-stores-contract`, `rules-cas-race.pg.test.ts` |
| **†** *(new 2026-09-14)* `tax_rates` had **no** foreign key to `tax_classes`, and the contract relies on it: rates are created for classes nobody declared, and are counted and returned | a rate for an undeclared class is not lost | `tax_classes/{classId}` is the document that holds a class's **rates**, and its `name` says whether the class was ever declared. `null` is the undeclared case — created on demand by a rate, skipped by `listClasses`, `not_found` for `updateClass`/`deleteClass` (exactly what the missing row produced), adopted rather than collided with by a later create, and deleted with its last rate so an undeclared class leaves no litter | `rules-stores-contract` |
| **†** *(new 2026-09-14)* `getRate(class, zone)` — the SQL had no unique index on that pair, so more than one rate can match and `LIMIT 1` chose arbitrarily | the checkout reads the same rate every time | the **lowest rate id** wins, by keeping the embedded rates sorted by id and taking the first match — deterministic where the SQL was not. This read goes **nowhere near** a claim document, so it never heals and never writes (see the Amendment's claim-document rule) | `rules-stores-contract` |
| order notes `append` and payment events `dedupe`: `ON CONFLICT (idempotency_key) / (dedupe_key) DO NOTHING`, re-reading and returning on conflict | append once-only; a webhook redelivery is processed once | the key **is** the document id — notes inside the order document, payment events as their own claim collection | `order-notes-store-contract` "replaying the same idempotencyKey is once-only (appended:false, same note, no duplicate)"; payment-event dedupe has **no direct suite** and the new adapter should add one |
| reporting `lowStock`: the join carries `product_commerce.deleted_at IS NULL` **as a join condition** | a soft-deleted product sharing a live sku neither duplicates the row nor titles it | the low-stock read filters on the product document's own tombstone before pairing it with inventory | `reporting-store-contract` "lowStock: a soft-deleted product sharing a live sku neither duplicates the row nor titles it" |
| `parseAggregate`'s overflow guard: a summed aggregate outside the safe-integer range throws `RangeError` rather than silently losing precision | money is never silently wrong | rollup counters are summed with the same guard; **the rollup design must keep it**, since summing day documents in JS is exactly where precision would be lost | `parse-aggregate.test.ts` asserts it directly — a bigint string above the safe range and a non-integer both `toThrow(RangeError)`. **That suite lives in the package being deleted**, so it must be **re-pointed at the reporting adapter** rather than lost; owning increment: reporting rollups |

## Consequences

**What becomes easier.** Several invariants stop being conventions and become structural: order snapshot
immutability (a `readonly` array written once), "flipped but no event" (one write), one-totals-per-order
(a field). **†** The held-stock refusal on a rename was listed here too, as "a read of the document being
written"; it is **struck**, because the ratified carry-after-product-write order makes it advisory rather
than structural — see §7.6, where the weakening and what it costs are stated. Idempotency
stops being a unique index anyone can forget and becomes a primary key. And **no host-side transactions
exist anywhere**, which is a feature: a lock-order deadlock is **unreachable by construction**, because
there are no locks to order — which retires the one deadlock the SQL avoidance never fully closed. The
old package had **no** deadlock retry at all; it relied entirely on lock ordering. The new retry loop
treats a host-level retryable abort — a serialization failure or a deadlock, surfaced as a structural
serialization error — identically to a lost compare-and-set, so a host above read-committed is covered
by the same bounded budget.

**What becomes harder, and what we accept.**

- **Write amplification.** The store is a single JSON column, so a compare-and-set rewrites the whole
  document. Order documents grow with items, events and refunds, and **the deployed tier has per-row and
  per-value size limits** — which is why the cap is a hard assertion rather than a guideline: prune
  terminal holds after the terminal answer is written, bound the movement and transfer rings, measure the
  p99 document size and assert a cap at the order-store increments, and split notes into a child
  collection if the number demands it. **†** It did: `notes[]` is **not** a field of the order document,
  and order notes are a child collection keyed `${orderId}:${noteId}` (§4). The cart's mutation ledger
  and the inventory transfer ring are bounded for the same reason, and a **claimed-but-incomplete**
  ledger record is never pruned — only completed ones are, which is what keeps a bound from eating an
  unfinished intent.
- **Contention, with no structural fix.** A hot aggregate retries. The answer is §2's measured budget
  plus a typed retryable error — not an unbounded loop, which turns contention into a hung request, and
  not a silent give-up. **†** The shape that once sat **at** the ceiling — the merchant removal shape,
  whose refused removals still write a ledger entry, so its writes are not bounded by the units — now
  measures comfortably under it and asserts only `<= CAS_MAX_ATTEMPTS`, so **no shape sits at the ceiling
  today**. That is the raise working, not the constraint disappearing: the budget is still real, and the
  assertions are upper bounds rather than measurements. A change to the ceiling is a change to the
  budget: measure first, then move it.
- **Two windows instead of one atom**, plus a bounded ring-eviction residual — all three named, and all
  three covered by fault injection rather than argued away.
- **Sweepers are load-bearing.** Unfinished movement claims, partial cross-SKU batches, partial cart
  expiries, partial sku transfers, claimed-but-unapplied coupon redemptions, derived search documents and
  reporting rollups all depend on a sweeper for their completion guarantee. A missing sweeper is a
  correctness bug, not untidiness. **†** The Amendment names the full set the adapters as built now
  require, and which increment owns them.
- **† Reads may write, and a read may throw where SQL could only return null.** Where a claim document
  is the fast path rather than the definition of existence, an id-keyed read that does not resolve falls
  back to a bounded parent scan and **re-establishes the claim** — so the read writes, and an id that
  does not exist costs a full paged scan that can raise the typed page-limit error instead of answering
  `null`. The Amendment states the rule and its cost table's location; the trade is deliberate, and the
  checkout reads are on the free side of it.
- **† Some refusals became louder than the SQL's, and that is a consumer obligation.** A provider
  reference already claimed by another order, and an outbox entry id that cannot be located, now raise
  typed errors where the SQL was silent. Louder is right — both states are real and both were previously
  invisible — but each has a handler that must be written: a non-retryable acknowledgement plus an
  anomaly for the first, a retry or the next tick for the second. **A third joined them:** a delivery
  check carrying neither scope throws where the SQL adapter and the in-memory fake both return `false`
  (§7.17). It is fail-closed either way, and it is unreachable from a route that has an order id or a
  session — so the obligation is narrow: a caller that can construct a scopeless query must handle a
  throw rather than read a `false` as "not entitled", and the domain fake still answers `false`, which a
  later `[Domain]` change should reconcile.
- **Compensations replace rollbacks.** Where the SQL undid a write by aborting a transaction — the
  coupon per-customer refusal above all — the document model must write an explicit, idempotent
  compensation, and get its ordering right.
- **Reporting becomes write-time work**, with past-bucket decrements and paged reads.
- **†** **32 rows naming 35 collections** to declare and keep in step with the descriptor — their
  index lists part of the read contract. The count rose from the ~22 first estimated, and every
  addition is a claim or locator document standing in for a lookup the port signatures force (§4).
- **The orders search narrows** as recorded in 6.1.

**Rejected alternatives.**

- **A two-step whose second step is not itself atomic.** A reservation held elsewhere cannot tell
  crash-before-decrement from crash-after unless the inventory document records the applying reservation.
  What makes the production two-step safe is that **step 2 is atomic**, not that there is no step 1.
- **A multi-row atomic batch.** Not available, and not being asked for.
- **Host-side transactions over several guarded updates.** They would reintroduce lock-order deadlock,
  and they do not exist on the deployed tier anyway.
- **Keeping any coupling on the commerce service.** The service is being removed (ADR-0020).
- **One mega-collection with a `type` discriminator.** Defeats per-collection indexes and guarantees
  hot-document contention.
- **Mirroring the SQL tables one-to-one as collections.** Recreates every cross-row coupling a guarded
  single-document update cannot express — the whole problem.
- **Relying on a declared `uniqueIndexes` for once-only.** It materializes silently-optionally at best
  and not at all in either test tier.

**What would reopen this decision.** A nested-path guarded update reaching the host, which would make
reserve lock-free again and retire the contention budget; a measured contention or document-size figure
no pruning, bounding or lazy-loading can bring back inside budget; or the prefix-only search narrowing
proving unacceptable, which is a port-widening change with its own record.

## Amendment 2026-09-14 — Phase B as built

The record above was written with **one** tier built — inventory — and the rest as design. The cart,
order, product-commerce, coupon and shipping/tax-rules adapters have since been built against it, and
this amendment records what building them changed. Everything marked **†** in the sections above was
corrected in place by this amendment; this section says what changed, why, and where the living detail
is. The decision itself — one document per aggregate, a coupling made idempotently completable and swept
— is **unchanged and reaffirmed**: nothing built needed a rule this record does not already state.

**2026-09-14 (later): §4 rows corrected to the declared layout after the identity and misc
stores landed.**

**2026-09-14 (later still): §4 gains the reporting rollups' claim collection, and the
`reporting_daily` row is confirmed as built. The rollups needed a second collection the
earlier table did not name — one claim per `(order, transition)` and per `(order, refund)`,
which is what makes a redelivered event a no-op — and its ordering against the counter
write is the tier's residual choice: the claim is written FIRST, so a crash leaves an
UNDER-count that the recompute repairs rather than money counted twice (rule (c)). The
recompute itself is a method on the adapter, and scheduling it is a later change, as item 7
of the list below already says.**

Three kinds of change are recorded, and they are worth keeping apart:

- **Corrections.** Statements that were false. §1's `updateIf` count and tier name, §2's "`release` still
  throws untyped" and its `CAS_MAX_ATTEMPTS` value, §3's R2 (the email lease is a compare-and-set, not an
  `updateIf`), §6.1 (three arms, not one field) and §6.3 (the cursor is decided), §7.6's "the held-stock
  refusal becomes structural", §7.11's single-field derivation, §7.13's lease row, §7.14's "the attach
  guard becomes a read of the hold".
- **Additions.** Collections, indexes and guards that had no row: §4's claim and locator collections and
  every index list that moved, and the new §7.13 and §7.17 rows.
- **Generalizations.** Four rules that recurred across the adapters and are now stated once, below.

### The four cross-cutting rules

These emerged independently in more than one adapter, which is the only reason they are stated as rules
rather than as adapter facts.

**(a) For a leased or claimed step, the owner's document revision IS the owner token, and it must be
re-asserted by a compare-and-set immediately before every write it guards.** A lease's whole purpose is
to let a step be taken over from an owner that has died — and a dead owner and a merely slow one are the
same document. So the taker's rule (wait for the lease to lapse) is only half of it; without the other
half a writer parked past the window wakes up and commits work it no longer has the right to do.
Re-asserting the revision immediately before the guarded write shrinks that to the gap between two
adjacent statements, and it must run on **every attempt** of the retry loop, carrying the revision
forward from the heartbeat's own result. A failed re-assertion is a typed refusal, never a write. Three
sites, reached separately and identically: the **sku claim's** heartbeat before every applying product
write (R4, §7.16); the **coupon bump right's** heartbeat before every counter write (R1, §7.8); and the
**rules child claims'** re-assertion before every embed, with the mirror rule on the way out — a delete
**un-embeds first**, then releases only at a revision read *after* the un-embed and only if the claim
still names this parent.

**(b) A claim document is the fast path, not the definition of existence.** Nine port methods across the
two rules stores take a child id the port never pairs with a parent, and the claim document is how they
reach it — but a claim can be orphaned by a crash, and answering "not found" from a missing claim would
strand an id that really is embedded. So an id-keyed read that does not resolve **falls back to a bounded
scan of the parent collection and re-establishes the claim**, and the create path's collision test runs
through the same lookup, which is what keeps one child id out of two parents. Three consequences follow,
and all three are surprising enough to state: such a read **may write**; it **may throw** the typed
page-limit error where the SQL could only return `null`; and the healing is automatic rather than
operator work. The cost is not uniform and the asymmetry is the point — a claim that resolves costs
nothing extra, and the checkout reads do not consult a claim at all, so they never heal and never pay.
The package README's "The one residue, and why it is healed rather than prevented" tabulates the cost per
call.

**(c) A residual resolves toward over-refusal, never toward overselling or over-granting.** Where a
window cannot be closed without cross-document atomicity, the surviving state is chosen so the system
refuses something it could have allowed rather than allowing something it should have refused. The coupon
counter's two residuals — a release compensation and a crash after the increment — are both **one HIGH,
never one LOW**, so the coupon can only over-refuse. The sku rename's owed carry is a **phantom
out-of-stock on the target, never an oversell** (§7.6). Inventory's ring-eviction residual re-applies a
movement rather than inventing an answer. In every case exactness is restored by a **recount sweeper**,
not by a tighter guard — which is the honest division of labour: the guard is responsible for never being
wrong in the dangerous direction, the sweeper for eventually being exact.

**(d) A lease constant is an operating parameter, so it is named, defaulted and overridable per store.**
Two exist: the sku claim's abandon window (`CLAIM_ABANDON_AFTER_MS`, **60 s**, option
`claimAbandonAfterMs`) and the coupon bump right's lease (`COUPON_BUMP_LEASE_MS`, **10 s**, option
`bumpLeaseMs`). Both are justified against the same retry budget rather than picked: a write that retries
at most `CAS_MAX_ATTEMPTS` (24) times with a backoff capped at 50 ms per sleep cannot legitimately hold a
step for more than about a second, so a 10-second lease is an order of magnitude of headroom over the
slowest honest owner, and 60 seconds is two — long enough that an in-flight writer is never mistaken for
a dead one, short enough that the residue heals without an operator. They are overridable because a test
needs to open the window deterministically and an operator on a slower host may need to widen it.

### The residuals this amendment accepts

Named rather than argued away, and each covered by a crash-seam case driven from the forbidden side:

- **The heartbeat-to-write gap.** Re-assertion shrinks the takeover window to two adjacent statements;
  it cannot remove it, because the re-assertion and the write it guards are different documents. The
  exposure is bounded by one full lease.
- **Clock skew costs a spurious retry, never data.** Both leases are compared against a clock the owner
  and the taker read separately. Skew can make a taker think a live lease has lapsed — at which point the
  owner's next re-assertion fails and it refuses, which is rule (a) working, not failing. No invariant
  depends on the two clocks agreeing.
- **An overtaken writer's empty target document survives** under the newcomer's sku, when the overtaken
  claim had created it. `createsTarget` is what makes it withdrawable at all (R4); a claim that adopted a
  pre-existing document must never have it withdrawn.
- **A carry completed from the inventory document's stamp writes no rename audit pair** — the replayer's
  and the inventory sweeper leg's route, because the audit entries are derived from a command key that
  route does not have, and an entry invented there would claim a movement it cannot
  attribute. A completion driven from the product's **recorded intent** — a later product write, or the
  product-side sweeper leg — does write the pair. So the trail is honestly incomplete only for a rename
  that crashed mid-flight (§7.6).
- **The coupon counter's HIGH-only residuals**, per rule (c).

### The sweepers the adapters now require

**The sweepers are not designed here — the sweeper increment owns all of them**, including their
scheduling, their batch sizes and their anomaly reporting. This record's obligation is only to say which
ones the adapters as built now *depend* on, because a missing sweeper is a correctness bug (Consequences)
and that list has grown:

1. **Inventory movement claims** — mark a claim `applied` while its key is still witnessed by the
   aggregate's ring or a hold's `lastMovementKey`, before eviction can occur (§2's sweeper contract).
2. **Orphan reservation index entries, and claimed-but-never-completed reservation key documents.**
3. **Partial cross-SKU hold batches** — driven from the order's own recorded intent via the
   `holdsPendingAt` index and the singular per-id calls, **never** by re-running the batch: a batch skips
   an id already terminal in the index, so a SKU caught between its terminal record and its prune is not
   healed by a replay (§2).
4. **Partial cart hold expiries** — a line flipped to `expiring` whose release or removal did not follow.
5. **Partial sku transfers** — an owed carry whose source is stamped. Note this one has an in-path
   healer too: **any later write on the product completes it first**, so the sweeper is the backstop
   rather than the only route (§7.6).
6. **† A coupon sweeper, which no earlier list named.** It completes or releases claimed-but-unapplied
   redemptions, frees per-customer slots, and — this is the part rule (c) makes mandatory rather than
   tidy — **recounts** the global counter, because the counter's accepted residuals are HIGH-only and a
   recount is the only thing that restores exactness.
7. **Derived search pointers and reporting rollups**, as already recorded.

The rules and product-commerce claim healers need **no** sweeper leg: both heal in-path by rule (b), and
the rules stores' residue is repaired by the next id-keyed read of the affected id. An orphaned claim
misleads no reader and strands no id meanwhile — every id-taking method answers exactly as it would for
an id that was never created, and the next create of that id takes the claim over.

### Where the living detail is

This record is the decision; `packages/store-emdash/README.md` is the detail, and it is the one to read
for anything measured or per-method. In particular: "Contention budget" and "Coupon contention, measured"
for the live per-shape figures — **do not copy them here, they drift**; "The admin list, the search and
the keyset cursor" and "The outbox locator" for §6; "What the carry cannot make atomic, stated exactly"
for §7.6's weakening; "The redemption state machine" for R1; "Two deviations from the design's index
table, both forced" and "Four deviations from the design's index table, all forced" for §4's index lists;
and "Why two claim collections, where the design table names none" plus "The one residue, and why it is
healed rather than prevented" for rule (b).

**Still open, and not closed by this amendment.** The `InventoryStore` port docblock does not document
the retryable contention outcome of `reserve`/`adjust`, and the in-memory fake treats an unstamped hold
as adoptable where the port, the SQL reference and the document adapter do not — both are docs-and-fake
follow-ups in the domain, outside this record. The mapping of the retryable contention error to a
retryable HTTP response is still owed by the route increments. And §5's substance is unchanged: the
descriptor still declares no storage, so §4's lists become a **pinned** read contract only when it does.
