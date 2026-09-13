# 0019. Commerce aggregates are one storage document per aggregate; idempotency is the document id

- Status: accepted
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
| Lock-free fast path | `updateIf` — guard and arithmetic in one statement; no read, no retry | contended **pure-counter** writes, where the whole invariant is one comparison on one field |
| General read-modify-write | `compareAndSet(id, revision, nextDoc)` with bounded jittered retry | **everything multi-field**: arbitrary invariants computed in JS, committed atomically against one document |

`updateIf` reports `applied: false` for an absent row **and** for a failed guard, deliberately
indistinguishable — so a caller that needs to tell the two apart must read, which is itself a reason
most writes are `compareAndSet`.

**How many `updateIf` sites the design has, stated honestly: three are planned, and zero exist today.**
They are coupon redemption's global counter bump (§3, R1), the coupon **release floor** guarded on
`usesCount > 0` (§7.15), and the email-outbox lease (§3, R2). All three are pure-counter writes whose
whole invariant is one comparison on one field; every other adapter write is `compareAndSet`. The count
is a design property to be checked when those adapters are built, not a fact about the tree.

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
`CAS_MAX_ATTEMPTS = 12`, first delay 2 ms doubling to a 50 ms cap. **This is a permanent budget** —
the aggregate is written by read-modify-write and there is no structural fix.

| Shape | Attempts asserted | Typed contention failures asserted | Reported measurement |
|---|---|---|---|
| 5 units, 50 racers, 20 loops (flash sale) | `<= 8` (`CAS_ATTEMPT_BUDGET`) | — | 5–6 attempts |
| 1 unit, 100 racers | `<= 8`, and `<= 6` | — | 2 attempts |
| restock +10 racing 40 reserves on 5 units, 15 loops | **not asserted** (logged per case) | **not asserted** | 12 attempts, 2–6 failures — **README measurement, no in-code figure** |
| restock then 40 reserves on 15 units, sequenced, 10 loops | **not asserted** (logged per case) | `<= 5` **per loop** (×10 loops) | 12 attempts, 0–1 failures — **README measurement, no in-code figure** |
| 20 removals racing 20 reserves on 12 units, 15 loops (**600 calls**) | `<= 12` (`CAS_MAX_ATTEMPTS`) | `<= 90`, i.e. 15% of calls | 12 attempts; **11–29** failures |

Three honesty notes on that table. The right-hand column is a **record of measurement, not an
assertion**: only the flash-sale shapes and the removal shape assert a depth at all, and the two restock
shapes merely log theirs per case, so a regression there is caught by their contention and conservation
assertions rather than by a depth ceiling. For the two restock rows the figures exist **only in the
package README** — there is no in-code comment or assertion carrying them, so nothing in the source
corroborates them and they should be re-measured rather than cited. The removal shape is the one row with
a figure in both places, and they **disagree**: the race file's own comment says 11–29 while the README's
table says 8–29. There the code comment is the figure to trust, and reconciling the README is a follow-up
for whoever next touches it. Note also that the sequenced row's ceiling of 5 is **per loop**, asserted
ten times, not a cumulative budget for the case.

`CAS_ATTEMPT_BUDGET = 8` is asserted to be strictly below `CAS_MAX_ATTEMPTS`. The two flash-sale
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

One further honesty note: `release` on a reservation that is neither live nor already released still
throws an **untyped** `Error`, exactly as the SQL store did. Typing it is an open follow-up, not
something this model fixed.

### 3. The design the remaining adapters implement

Inventory is built. **Everything in this section is design the remaining adapters must satisfy, not a
description of code that exists.**

| Coupling | Shape | Invariant preserved | Proven by | Owning increment |
|---|---|---|---|---|
| Order creation from a cart | **(b)** `order_keys/{idempotencyKey}` intent claim carrying the full intent, then **(a)** create-if-absent of one `orders/{orderId}` document holding header, `readonly items[]`, totals and address | replay once-only; snapshot immutability becomes structural | `order-store-contract`, `order-flow` | order-store core |
| Refunds and their capacity | **(a)** `payments[]` and `refunds[]` embedded; the ceiling computed **inside** the read-modify-write and committed by the same compare-and-set; plus `refund_keys/{refundKey} → orderId`, because the settle path has only the key | ceiling never exceeded; refund once-only | `refund-order-contract`, `refund-race` | order-store refunds |
| State transition | **(a)** the guarded flip, the `events[]` append and the first-wins `emailOutbox[]` entry are **ONE** compare-and-set guarded on revision and on `state === from` | transition once-only; audit completeness | `order-transition-contract`, `order-timeline-contract`, `outbox-dispatch` | order-store core |
| Email-outbox lease | **(a)** one `updateIf` on the denormalized `emailDueAt` (R2 below) | a message is sent once and a crashed dispatcher's row becomes claimable again | `outbox-dispatch` | order-store lists |
| Orders list, search and customer view | **(a)** three denormalized indexed fields — `searchKey`, `customerKey`, `emailDueAt`; the customer filter stays a union, expressed as `customerKey in [customerId, foldedBuyerRef]` (R3 below) | one row per order; count agrees with the page; a guest's not-yet-relinked orders are neither undercounted nor mislabelled | `order-store-contract` list cases, ADR-0017's refresh cases | order-store lists |
| Hold adoption / commit across N SKUs | **(b)** the order document records the adoption/commit **intent** before any per-SKU write; each per-SKU write is idempotent by reservation id; a sweeper completes a partial set; reservation id → sku from `reservation_index` | a paid order never has a hold left un-committed and then reaped | `inventoryStoreContract` batch cases, multi-line checkout race | order-store core + sweeper |
| Sku rename | **(b)** one compare-and-set on the source zeroes `onHand` and stamps `transferOut: { token, toSku, qty }`; the target applies iff `appliedTransfers` lacks the token (bounded ring); the source clears it. The held/adopted refusal is read from the **same** document | stock conservation; the held-stock refusal; idempotent replay | `product-commerce-store-contract`, `sku-rename-ledger`, `sku-rename-race`, `variant-sku-rename-race` | product-commerce store |
| Live-sku uniqueness across two grains | **(b)** `sku_owners/{sku}` claim doc (R4 below) | one live owner per sku, across products **and** variants | `product-commerce-store-contract` precedence cases | product-commerce store |
| Cart hold expiry | **(b)** guarded flip of the line to `expiring` (once-only token) → release the reservation → remove the line. Today's fixed **lock** order becomes a fixed **step** order. A sweeper completes a partial | hold expiry returns stock exactly once | `cart-store-contract`, `hold-expiry`, `cart-fence`, `no-oversell-cart` | cart store |
| Coupon redemption | **(b)** then **(a)** — per-customer claim first, then the global counter (R1 below) | no over-redeem; **a per-customer rejection never consumes global headroom** | `coupon-store-contract`, `coupon-lifecycle`, `coupon-no-over-redeem` | coupon store |
| Reporting rollups | **(b)** keyed on the order's **creation** day, so a transition decrements one bucket and increments another **in a past bucket**; `ordersByStatus` moves an order between state buckets; **refunds roll up independently of transitions**; idempotent per `(orderId, transition)` and **swept** | reported figures equal a from-scratch replay | `reporting-store-contract`, `reporting.seeded`, plus a crash-between-transition-and-rollup case **to be written** | reporting store + sweeper |

Six of these needed a ruling, because the naive translation is wrong.

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
is sent or failed, otherwise `max(dueAt, leaseUntil)`. The lease is then a single `updateIf` guarded on
`emailDueAt <= now` that sets `emailDueAt = now + leaseLength` and increments attempts — so the
lock-free path survives here.

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
`{ ownerKind: "product" | "variant", ownerId, live: boolean }`. A soft-delete or an orphaning
**releases** the claim — delete the document, or set `live: false`, and a new claimant may take over a
non-live document by compare-and-set. `SkuConflictError` outranks `SkuStockConflictError` exactly as
today. The two partial unique indexes' semantics — unique **among live rows only** — thereby become a
document invariant instead of a database feature the document store does not have.

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

| Collection | Doc id | Declared indexes | Unique indexes |
|---|---|---|---|
| `inventory` | sku | — | — |
| `reservation_keys` | reserve idempotency key | — | — |
| `reservation_index` | reservation id | — | — |
| `inventory_movements` | `stock:<key>` / `adjust:<key>` | `sku`, `createdAt` | — |
| `carts` | cartId | `state`, `holdExpiresAt` | — |
| `orders` | orderId | `state`, `createdAt`, `customerKey`, `searchKey`, `[state, createdAt]`, `emailDueAt` | — |
| `order_keys` | order idempotency key | — | — |
| `refund_keys` | refund idempotency key | — | — |
| `order_sku_index` | `${sku}:${orderId}` | `sku` | — |
| `product_commerce` | productId | `sku`, `active`, `taxClass`, `titleLower` | — |
| `sku_owners` | sku | — | `sku` (declared; **not** the enforcement) |
| `coupons` | code | `createdAt` | — |
| `coupon_redemptions` | `${couponId}:${idempotencyKey}` | `couponId`, `orderId` | — |
| `coupon_customer_caps` | `${couponId}:${customerId}` | — | — |
| `customers` | customerId | — | — |
| `customer_emails` | folded email | — | `email` (declared; **not** the enforcement) |
| `sessions` | token hash | `customerId` | — |
| `login_challenges` | challengeId | `emailLower`, `expiresAt` | — |
| `entitlements` | grant idempotency key | `customerId`, `scope` | — |
| `payment_events` | dedupe key | — | — |
| `shipping_zones` / `tax_classes` | zoneId / classId | — | — |
| `settings` / `settings_mutations` | `"store"` / mutation key | — | — |
| `reporting_daily` | `${currency}:${YYYY-MM-DD}` | `currency`, `date` | — |

Two corrections against the plan's table. The `orders` customer index is `customerKey`, not
`customerId` (R3). And **`coupons` carries no `active` index** — the coupon table has no active or
soft-delete column at all, so declaring `active` would be a read contract for a field nothing writes.
It does, however, need **`createdAt`**: the admin coupon list is keyset-ordered on `(created_at, id)`
with a dedicated index behind it, and ordering by an undeclared field throws exactly as filtering on one
does. The list's only *filter* is a code search; its *ordering* is what `createdAt` serves.

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

1. **The orders-list search narrows to a prefix-only denormalized `searchKey`. Ratified.** The old
   predicate is an OR of three arms, and an AND-only filter with opaque per-query cursors cannot express
   it — "issue two queries and merge under a stable sort" produces neither a correct next cursor nor a
   correct count. All three arms denormalize into one indexed field with **prefix-only** semantics, a
   user-visible narrowing on two axes: the buyer reference stops matching mid-string, and the composite
   key changes what a partial id or sku matches. **The narrowing will be documented in the screen's
   empty state at the lists/UI increment.** Widening the domain port instead remains available as a
   separate change with its own PR.
2. **Correlated existence (search by line sku)** → `order_sku_index` documents, written after order
   creation, derived and idempotent (so needing no atomicity), healed by the sweeper. They feed
   `searchKey`.
3. **Keyset pagination maps in shape but not in token.** The domain cursor is a value position; the host
   cursor is an opaque host-minted string whose seek re-reads the cursor row by id. The adapter will
   either round-trip the host token through the route or re-derive the position — **decided at the
   order-store lists increment**, which must also write a **deleted-cursor-row** case, since a deleted
   cursor row is a paging fault with no analogue today and **no such test exists anywhere in the tree.**
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
source clearing. The held/adopted refusal becomes **structural**, because the holds it checks are in the
very document being written. A fixed lock order is replaced by a fixed step order, and there is no lock
to order — which also retires the residual deadlock above.
*Proven by:* `product-commerce-store-contract`'s refusal cases at both grains, `sku-rename-ledger`, and
`sku-rename-race`/`variant-sku-rename-race` — including the crossing-renames case where one side refuses
typed and neither deadlocks, satisfied on documents by there being no lock at all.

#### 7.7 The cart hold expiry transaction

*What the SQL guaranteed.* One transaction re-checked the deadline, returned the units and deleted the
line, so a line could never be deleted without its units coming back. The re-check was the flip's own
guard: `state = 'held'` **and** either a stamped deadline at or before now, **or** an unstamped hold
older than the cutoff **that also has a cart-mutation ledger row** — an existence test which is what
kept the cart sweep from reaping a hold no cart created. Only the flip winner incremented `on_hand` and
deleted the line.
*Invariant:* **exactly-once expiry.**
*Now guaranteed by:* the intent-claim — a guarded flip of the line to `expiring` (the once-only token),
then the release, then the removal, with a sweeper completing a partial. The null-deadline arm's scoping
survives as a property of the cart document that owns the line: a hold with no cart line is not the cart
sweep's to reap. Checkout keeps the shape it already has — a single guarded flip whose `state = 'active'`
predicate is itself the write-once, so a replay reports "already done" rather than failing.
*Proven by:* `cart-store-contract`/`hold-expiry`, whose cases are the specification here — an expired
hold is released and its stock returns, a lazy read racing the sweep returns stock **exactly once**, a
hold whose TTL was reset between listing and release is not reaped, a non-cart hold older than the TTL is
not reaped — plus `cart-fence` and `no-oversell-cart.pg.test.ts`.

#### 7.8 The coupon guard — `uses_count + 1 WHERE max_uses IS NULL OR uses_count < max_uses`

*What the SQL guaranteed.* One statement incremented the counter only while headroom remained; zero rows
meant exhausted. The `OR` made an uncapped coupon unconditional in the same statement. The per-customer
cap was then checked **after** that bump, in the same transaction, by **counting** the customer's
redemption rows — race-free because the coupon-row update had already taken the row lock — and its
refusal was undone by **rolling the transaction back**, so a per-customer rejection consumed no global
headroom.
*Invariant:* **no over-redeem**, and no global headroom consumed by a per-customer refusal.
*Now guaranteed by:* R1's inverted order plus an idempotent compensation, because there is no rollback.
*Proven by:* `coupon-store-contract`/`coupon-lifecycle` — the per-customer cap case, the guest-checkout
degradation case, and the same-key replay — and `coupon-no-over-redeem.pg.test.ts`, where N concurrent
redeems at cap M leave exactly M successes and two same-customer concurrent redeems at a per-customer cap
of 1 leave exactly one.

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
*Now guaranteed by:* the prefix-only `searchKey` denormalization (6.1) and the `customerKey`
denormalization (R3) — one indexed field each, one row per order by construction, and a count sharing the
identical predicate. The customer half remains a **union**, not an equality: it becomes
`customerKey in [customerId, foldedBuyerRef]`, which the filter algebra supports directly and which a
document matches at most once. R3 records the single edge that narrows and hands it to the lists
increment. The sku arm's semantics survive as `order_sku_index` documents feeding
`searchKey`, still derived from the **frozen** lines. The half-open window needs no denormalization at
all: `gte` and `lt` express it directly.
*Proven by:* the list and count cases in `order-store-contract`, ADR-0017's refresh cases, and a
one-row-per-order case under a multi-line sku match. The **deleted-cursor-row case must be written** at
the lists increment — no such test exists today, in any suite.

#### 7.12 Inventory store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `commit`: flip `WHERE id = :id AND state IN ('held','adopted')`; on zero rows re-read and return if already `committed`, else raise `ReservationCommitLostError` (or `ReservationNotFoundError` when no row exists) | commit once-only; a hold that is not live can never be silently committed | the reservation's terminal state in `reservation_index` plus the live hold in the aggregate; both typed errors preserved | `inventoryStoreContract` for the batch path. The singular commit-lost throw has **no case in the shared contract file**, but it *is* asserted twice outside it — `order-flow.dialects.test.ts` ("commit against a released reservation throws the loud `ReservationCommitLostError`; against a committed one it is a benign no-op") on every dialect, and the document adapter's own crash-seam suite, which asserts the same class for an orphaned index entry. Folding a case into the shared contract remains worthwhile |
| `release`: `released` returns; any other non-live state throws an **untyped** `Error`; a lost flip inside the transaction is a **silent no-op** | stock returns exactly once | the same two reads, and a lost settle is still a silent no-op. **The untyped error is preserved as-is** — typing it is an open follow-up, not a change this model made | `inventoryStoreContract` "commit finalizes; release returns stock; double-commit and double-release are no-ops"; "release(unknownId) rejects with ReservationNotFoundError" |
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
| `claimNextEmail`: `sent_at IS NULL AND status != 'failed' AND (lease_until IS NULL OR lease_until <= :now)`, claimed by re-applying the same predicate and setting `status='sending'`, a caller-supplied `lease_until` and `attempts + 1` | a message is sent once; a crashed dispatcher's row becomes claimable again | R2's single `emailDueAt` field and one `updateIf` guarded on `emailDueAt <= now` | `outbox-dispatch` "a crashed dispatcher run leaves the row claimable again after its lease expires"; "a failed send returns the row to pending; the next dispatch delivers it exactly once" |
| `resolveReconciliation`: compare-and-clear — sets the disposition and nulls the flag `WHERE id = :id AND reconciliation_flag = :expectedFlag` | a resolution never clobbers an anomaly re-raised since the operator read it | the same comparison inside the order document's compare-and-set, where the revision adds a second guard | `order-store-contract` "resolveReconciliation with a STALE expectedFlag is a 0-row miss: the re-flagged anomaly survives"; the non-flagged and once-only cases |
| `flagReconciliation`: unguarded, **last-writer-wins** | an anomaly is always recordable | preserved as last-writer-wins on the field; it is deliberately not a CAS | `resolve-reconciliation-race.pg.test.ts` |
| `recordPayment`: `ON CONFLICT (provider_ref) DO NOTHING` | a gateway redelivery records one payment | the provider reference keys the entry inside `payments[]`; a present key is a no-op | `refund-order-contract` captured-sum cases |
| `voidRefund` / `markRefundUnverified`: guarded flips out of `status = 'reserved'` | capacity is released or held deliberately, never by accident | R6, inside the order document's compare-and-set | the three `refund-order-contract` cases named in R6 |
| `order_totals.order_id` as PRIMARY KEY | one totals row per order | tautological once totals are a field of the order document | `order-store-contract` |
| `linkGuestOrders`: `WHERE lower(buyer_ref) = :folded AND customer_id IS NULL` | a guest's orders attach to exactly one account and never re-attach | the same predicate, **plus rewriting `customerKey`** (R3) so the customer filter keeps working afterwards | `order-transition-contract`'s guest-linking cases — the two-customer case, and "linkGuestOrders matches buyer_ref case-insensitively — a mixed-case guest checkout still links", whose second call returning 0 pins the no-re-attach half. (`order-store-contract` never calls `linkGuestOrders`) |

#### 7.14 Cart store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| the mutation ledger: claim `ON CONFLICT (idempotency_key) DO NOTHING`, complete by upserting `completed = 1` with the resulting line and qty, and **short-circuit a replay by reading the recorded result inside the transaction before any work** | a retried cart mutation never re-does inventory-affecting work | the mutation map embedded in the cart document, read and written in the same compare-and-set | `cart-store-contract` "add is idempotent…", "increase is idempotent…", "adjust replay after an intervening different-key adjust is a no-op returning the recorded result and moves no stock" |
| `upsertLine`'s hold stamp: `UPDATE reservations SET expires_at = :deadline WHERE id = :id AND state = 'held'`; zero rows raises `HoldExpiredError`. (It stamps the deadline; `state='held'` is a **precondition**, not something it sets) | a line is never visible attached to a hold that is no longer live | the same precondition read off the hold in the inventory document before the cart document is written | **no case in the shared contract file** — but the outcome *is* driven through the real Kysely adapter on every dialect by `reserve-cart-line-crash.dialects.test.ts` ("a late add replay after the sweep reaped its crashed hold does not resurrect a line"), which asserts the use-case's `HOLD_EXPIRED` reason rather than the class. The cart-store increment should re-point that case and add a store-level one |
| `(cart_id, sku)` unique upsert with a do-update conflict clause | one line per sku per cart | the lines map keyed by sku inside the cart document | `cart-store-contract` |
| `adjustLine`'s correlated subselect: when a reservation exists the stored line qty is taken from the reservation's own qty rather than the caller's | the line qty and the hold qty can never diverge | one document write derives the line qty from the hold it just read | `cart-store-contract` "increase delta-reserves the difference"; "decrease partial-releases and always succeeds" |

#### 7.15 Coupon store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `delete … WHERE NOT EXISTS (SELECT … FROM coupon_redemptions WHERE coupon_id = coupons.id)`, returning a typed `in_use_by_redemptions` **result** rather than throwing | a coupon with history is never deleted out from under it | a count of the coupon's redemption documents read before the delete, with the same typed result | `coupon-store-contract` "delete is forbidden while a redemption references the coupon (in_use_by_redemptions)"; "delete becomes possible once the redemption is released" |
| `release` / `releaseByOrder`: `uses_count - 1 WHERE uses_count > 0` — a **predicate guard**, so the counter never goes negative and a release at zero simply matches nothing | the counter never goes negative; release is idempotent | `updateIf` with the mirror-image guard `usesCount > 0` — the one place a pure-counter decrement keeps the lock-free path | `coupon-store-contract` "releaseCoupon on an already-released or never-redeemed id is a no-op, not an error"; "releaseByOrder … decrements uses_count, and is idempotent" |

#### 7.16 Product-commerce store — the remaining guards

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| `upsert`'s dual guard: `idempotency_key != :key` **and** an incoming CMS watermark that is null-or-not-older | a same-key replay and a strictly-older CMS delivery are both no-ops | both comparisons read off the same document inside its compare-and-set | `product-commerce-store-contract` "upsert replayed with the SAME idempotencyKey as the stored row is a no-op…" |
| `updateCommerceFields`/`updateVariantFields`: CAS `WHERE product_id = :id AND deleted_at IS NULL AND updated_at = :expected AND idempotency_key != :key`, and a **zero-row classifier whose order is load-bearing**: not-found (or soft-deleted) → same-key replay returns ok → `stale` → the currency mismatches | an operator never silently overwrites a newer edit, and the reason they are shown is the most specific true one | the same fields and the **same classifier order** inside one compare-and-set, with the document revision as a second, cheaper staleness check | `product-commerce-store-contract` "a same-key replay AFTER the row was soft-deleted is not_found…" |
| `activate`/`deactivate`: `WHERE deleted_at IS NULL AND active = :from AND (active_updated_at IS NULL OR active_updated_at <= :watermark)` | an out-of-order publish cannot re-latch a newer transition; a soft-deleted row never resurrects | the same watermark comparison in the document | `product-commerce-store-contract` "out-of-order: deactivate@T2 (newer) then a STALE activate@T1 (older)…" |
| `softDelete`: sets the tombstone `WHERE deleted_at IS NULL`, leaving the sku column intact — which **releases** the sku, because live-sku uniqueness is partial over non-deleted rows | delete is always a tombstone; the sku becomes reusable at once | the tombstone field plus **releasing the `sku_owners` claim** (R4), which is what makes the release explicit rather than a side effect of an index predicate | `product-commerce-store-contract` "softDelete sets deletedAt + active=false and retains the row (never a hard delete)" |
| `upsertVariant`: `ON CONFLICT (product_id, variant_key) DO NOTHING`, plus a resurrect path gated on the row being orphaned **and** the incoming watermark being strictly newer | the variant key is the immutable identity; a re-declare never mints a second row; revival needs a strictly-newer delivery | the variants map keyed by variant key inside the product document, same gate | `product-commerce-store-contract` "upsertVariant RESURRECTS an orphaned variant…" |
| the two **partial** unique indexes (`unique … WHERE deleted_at IS NULL` and `unique … WHERE orphaned_at IS NULL`) plus the **reciprocal** cross-grain checks, with `SkuConflictError` outranking `SkuStockConflictError` because the cross-table check runs first | one live owner per sku across products and variants, and the operator is told the more fundamental reason | R4's `sku_owners` claim document, with the precedence preserved by checking the claim before the stock | `product-commerce-store-contract` "PRECEDENCE: a product rename onto a sku a LIVE VARIANT holds refuses as SkuConflictError, never as a stock conflict"; `variant-sku-rename-race.pg.test.ts` |

#### 7.17 Identity, entitlements, settings, rules, ledgers and reporting

| Old guard | Invariant | Now guaranteed by | Proven by |
|---|---|---|---|
| settings `update`: read the recorded mutation and return it if present, else claim `ON CONFLICT (idempotency_key) DO NOTHING` and apply | a replayed settings key returns the recorded result and never re-applies the patch | `settings_mutations/{key}` as a claim document carrying the recorded result | `settings-store-contract` "update replayed with the same idempotencyKey returns the recorded result and does not re-apply" |
| entitlement `grant`: `ON CONFLICT (grant_idempotency_key) DO NOTHING`, then re-select and return the original | a grant is issued once | the grant key **is** the document id | `entitlement-store-contract` "grant is idempotent under grantIdempotencyKey — a replay grants once" |
| entitlement `check`: **a query with neither an order nor a buyer reference returns false** | an **authorization boundary** — delivery must be scoped, and an unscoped check must never be a wildcard pass (ADR-0011) | the same refusal, written as an explicit early return before any read | `entitlement-store-contract`; the empty-scope branch itself is **not named by a test today** and the new suite must name it |
| address `update`/`delete`: `WHERE id = :addressId AND customer_id = :customerId` on **both** | **cross-customer isolation** — a security invariant, not a convenience | an **explicit ownership check** on the address inside the customer's own document, since a document id alone carries no owner. This must be written as a check, not inherited from a key shape | `address-book-contract` "update is customer-scoped: B cannot touch A's address (returns null)"; "delete is customer-scoped: B cannot delete A's address" |
| session `validate`: `WHERE token_hash = :hash AND revoked_at IS NULL AND expires_at > :now`; `revoke`: guarded on `revoked_at IS NULL` | only a live, unexpired, unrevoked token authenticates; revoke is idempotent | the token hash is the document id; the two other clauses are field reads | `session-contract` "a revoked token no longer validates"; "an expired token no longer validates" |
| credential `verifyChallenge`: single-use consume `SET consumed_at = :now WHERE id = :id AND consumed_at IS NULL`; zero rows is the `CONSUMED` answer | a magic link works exactly once | a compare-and-set on the challenge document guarded on the consumed field being absent | `credential-verifier-contract` "verifyChallenge with an already-consumed token returns CONSUMED…" |
| `issueChallenge`'s throttle: **count-then-insert, not transactional, over a table with no unique constraint** — a genuine race | rate limiting | **must not be inherited silently.** The identity increment owns making the throttle a claim document, or recording why it stays best-effort | the cap is tested ("rapid repeat requests hit the per-email cap…"); **the race is not**, and a case must be written |
| shipping `deleteZone` / tax `deleteClass`: `NOT EXISTS` over children, returning typed `in_use_by_methods` / `in_use_by_rates` results | a zone or class with children is never deleted out from under them | children embedded in the parent document make the check a read of the same document | `shipping-rules-store-contract` "deleteZone is forbidden while a method still references it (in_use_by_methods)"; the tax twin |
| `updateRate` / `updateTaxRate`: money CAS on `amount_cents = :expected` / `rate_bps = :expected`, misses classified `not_found` vs `stale` | a rate edit never silently overwrites a concurrent one | the same expected-value comparison inside the zone or class document's compare-and-set | `rules-stores-contract`, `rules-cas-race.pg.test.ts` |
| order notes `append` and payment events `dedupe`: `ON CONFLICT (idempotency_key) / (dedupe_key) DO NOTHING`, re-reading and returning on conflict | append once-only; a webhook redelivery is processed once | the key **is** the document id — notes inside the order document, payment events as their own claim collection | `order-notes-store-contract` "replaying the same idempotencyKey is once-only (appended:false, same note, no duplicate)"; payment-event dedupe has **no direct suite** and the new adapter should add one |
| reporting `lowStock`: the join carries `product_commerce.deleted_at IS NULL` **as a join condition** | a soft-deleted product sharing a live sku neither duplicates the row nor titles it | the low-stock read filters on the product document's own tombstone before pairing it with inventory | `reporting-store-contract` "lowStock: a soft-deleted product sharing a live sku neither duplicates the row nor titles it" |
| `parseAggregate`'s overflow guard: a summed aggregate outside the safe-integer range throws `RangeError` rather than silently losing precision | money is never silently wrong | rollup counters are summed with the same guard; **the rollup design must keep it**, since summing day documents in JS is exactly where precision would be lost | `parse-aggregate.test.ts` asserts it directly — a bigint string above the safe range and a non-integer both `toThrow(RangeError)`. **That suite lives in the package being deleted**, so it must be **re-pointed at the reporting adapter** rather than lost; owning increment: reporting rollups |

## Consequences

**What becomes easier.** Several invariants stop being conventions and become structural: order snapshot
immutability (a `readonly` array written once), "flipped but no event" (one write), one-totals-per-order
(a field), and the held-stock refusal on a rename (a read of the document being written). Idempotency
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
  collection if the number demands it.
- **Contention, with no structural fix.** A hot aggregate retries. The answer is §2's measured budget
  plus a typed retryable error — not an unbounded loop, which turns contention into a hung request, and
  not a silent give-up. **One shape is asserted at the ceiling and two more were measured at it**, so the
  budget is a real operating constraint rather than a theoretical one — though only the asserted one is a
  guarantee. A change to the ceiling is a change to the budget: measure first, then move it.
- **Two windows instead of one atom**, plus a bounded ring-eviction residual — all three named, and all
  three covered by fault injection rather than argued away.
- **Sweepers are load-bearing.** Unfinished movement claims, partial cross-SKU batches, partial cart
  expiries, partial sku transfers, claimed-but-unapplied coupon redemptions, derived search documents and
  reporting rollups all depend on a sweeper for their completion guarantee. A missing sweeper is a
  correctness bug, not untidiness.
- **Compensations replace rollbacks.** Where the SQL undid a write by aborting a transaction — the
  coupon per-customer refusal above all — the document model must write an explicit, idempotent
  compensation, and get its ordering right.
- **Reporting becomes write-time work**, with past-bucket decrements and paged reads.
- **Roughly 22 collections** to declare and keep in step with the descriptor, their index lists part of
  the read contract.
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
