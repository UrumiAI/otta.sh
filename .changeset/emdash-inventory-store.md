---
"@otta-sh/store-emdash": minor
---

`EmdashInventoryStore`: the full `InventoryStore` port over document storage, on one
inventory document per SKU with the live holds embedded in it.

- **The holds live inside the inventory document, and that is the whole design.** An
  inventory decrement is not idempotent unless the row records *who applied it*. So
  the decrement is ONE `compareAndSet` on `inventory/{sku}` in which the
  `onHand >= qty` guard (computed in JS), the new count and the hold record all
  commit together — no oversell and once-only are the same atom.
- **Reserve is a two-step whose ONE crash window is the claim window, and it is
  healed.** The
  sequence is: claim `reservation_keys/{key}` create-if-absent, carrying the sku, the
  qty and the minted reservation id → the inventory `compareAndSet` → update the key
  document to its terminal `ReserveResult`. The window is "claim written,
  `compareAndSet` not yet run". Any replayer of the key finds the `claimed` document
  and completes it deterministically, reusing the **recorded** reservation id rather
  than minting a second one, so the decrement happens exactly once and every caller
  gets the same answer; a sweeper reaps claims nothing ever replays. What the embedded
  aggregate removes is the SQL adapter's *second* window — a `pending` reservation
  flipped to `held` separately from the decrement. The claim window cannot be removed
  by any single-document primitive, because the claim and the units necessarily live
  in different documents. Two cases pin it: an abandoned claim completes with the
  recorded id and decrements once, and a concurrent burst of reserves sharing ONE key
  yields one hold, one decrement and one reservation id.
- **The inventory CAS step has a window of its own, mitigated rather than removed.** A
  caller sits between reading the aggregate and committing its `compareAndSet`, and in
  that interval a peer completing the SAME claim can create the hold, commit it and
  prune it — leaving no hold under the key and a low count that a committed prune will
  never give back, so a second hold written there would be permanent, silent stock
  loss. Whenever `holds[key]` is absent the step therefore re-reads the key document,
  and a terminal one ends the attempt with the recorded answer and no write. The
  residual is the one storage round trip between that re-read and the write; removing
  it would need cross-document atomicity these primitives do not offer.
- **An `OUT_OF_STOCK` reserve mints nothing.** The pre-read decides it before an id
  exists, so a sold-out sku's traffic leaves only the terminal key document that makes
  the replay stable — no reservation id, no reverse-lookup document, no wasted write.
- **The outcome-before-prune ordering.** A hold is pruned on commit/release, so the
  terminal outcome is written to the key document **before** the prune and a replay
  reads that document first; prune-first-then-crash would let a replay conclude the
  key was fresh and decrement a second time. That *ordering* is only observable under
  fault injection, which is the race-and-crash tier's job: the suites here pin its
  consequence — a replay after commit, after release, and after a `commitMany` of an
  adopted hold each return the original answer and create no second hold.
- **`reservation_index` is not optional.** Six port methods take reservation ids with
  no sku, and a hold embedded per SKU cannot be found from an id alone. The index
  document is written before the hold, so an id absent from it is *provably* unknown —
  which preserves the port's asymmetry: `commitMany` throws
  `ReservationNotFoundError` for a truly unknown id, `adoptMany` folds one into
  `lost`. Its create-if-absent result is asserted, so a colliding id is a loud
  `ReservationIdCollisionError` rather than somebody else's reservation silently
  adopted. It also carries the reservation's terminal state, because pruning a hold
  would otherwise erase the difference between "never existed" and "existed and was
  released".
- **Cross-SKU work is honest about not being atomic.** `adopt` / `adoptMany` /
  `commitMany` / `releaseAdopted` classify every id up front, then apply one
  `compareAndSet` per SKU, each idempotent by reservation id, so a partial set is safe
  to re-run. Duplicate ids in a batch are collapsed: a membership set must not report
  an id twice because a caller listed it twice.
- **Every ledger is bounded.** `adjust`, `restock` and `removeStock` keep their
  once-only record in `inventory_movements` — one document per key, carrying the full
  intent and then `applied` with the recorded answer, which is also what makes a key
  reused for a different movement (or against a different reservation) the port's
  typed rejection rather than an `ok` echoing the wrong one. The hot aggregate keeps
  only a 256-entry ring of recently applied keys plus one field per hold, so no map on
  it grows without limit; the ring exists solely to make the one-round-trip window
  between a movement's write and its claim being marked `applied` idempotent. The
  residual that bound leaves — a replay delayed past ring-size movements on one sku —
  cannot be closed without a second atomic document, so it is accepted as bounded and
  written down as a contract the sweeper must satisfy (a claimed movement whose key is
  still witnessed is marked applied before eviction can occur).
- **`adjust` re-derives rather than refusing.** The port takes an absolute target, and
  the SQL reference re-derives the previous qty on every retry, so it always applies.
  A completion here likewise reads the hold's current qty and applies the target
  against it; the claim's recorded `fromQty` is audit, not a guard. The only outcomes
  are the port's own — `ok`, a genuine stock refusal on an unbacked increase, or the
  typed not-held error — and every caller, winner or same-key loser, derives its answer
  from the durable record, so one key can never produce two answers.
- **Retry exhaustion is a typed retryable error, never `OUT_OF_STOCK`.** Contention on
  a hot SKU is answered with bounded, full-jittered retry and a documented ceiling
  (`CAS_MAX_ATTEMPTS = 12`, measured rather than guessed: the depth a writer can lose
  is bounded by the units on hand, not by the size of the crowd). Exhaustion throws
  `StorageContentionError` with `retryable: true` and the last retryable host abort as
  its `cause`, to be mapped to 503 and a retry at the route boundary. Collapsing it
  into `{ ok: false, reason: "OUT_OF_STOCK" }` would tell a shopper who could have
  bought that the item is gone — a lost sale reported as a fact about the product.
- **Adopting a hold with no stamped deadline is refused**, per the port's own
  statement of the guard (`WHERE state='held' AND expires_at > :now`, which a SQL
  `NULL` never satisfies). The in-memory fake treats an unstamped hold as adoptable
  and is the outlier; reconciling it is a follow-up on the fake.

Verified by the domain's `inventoryStoreContract` — every case, no adapter-introduced
skips — on both dialects over real storage repositories, plus the concurrency suite on
the tier that can actually race: exactly the stocked number of winners on every loop,
the count ending at zero, a maximum retry depth strictly inside the ceiling, and the
shared-key burst resolving to one reservation.
