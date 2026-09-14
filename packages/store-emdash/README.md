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

## The D1 tier

D1 is the dialect a deployed storefront actually runs on, and the two Node tiers
never touch it: the conditional-write primitives ride the host's **SQLite branch**
there by inference. `updateIf` is one
`UPDATE … SET data = json_set(…) WHERE … RETURNING data`; revisions are stamped by
the `AFTER INSERT` / `AFTER UPDATE` triggers the conditional-write migration
creates on that branch. `better-sqlite3` runs the same SQL against a different
engine build, in a different process model. So this tier exists to answer, rather
than assume, whether D1 agrees.

```bash
pnpm test:d1        # from the repo root, or from this package
```

It runs under the Cloudflare workers vitest pool on the **local miniflare D1
simulator** — no Cloudflare account, API token, remote database or deployment is
involved, and nothing here can reach one. It is wired as its own vitest project
(`store-emdash-d1`, `vitest.d1.config.ts`) rather than into the default battery:
it boots `workerd`, migrates a fresh database per test file, and takes a couple of
minutes. CI runs it **nightly** and on manual dispatch, never per PR. Miniflare is
given the **storefront's own** compatibility date and flags
(`sites/staging/wrangler.jsonc`), so a divergence found here means something about
production rather than about an invented runtime.

**What the toolchain costs, stated plainly.** `@cloudflare/vitest-plugin` pins its
`wrangler` and `miniflare` versions **exactly**, and that `miniflare` in turn pins
its own `workerd` exactly. So installing it adds a third `workerd` build (~150 MB)
that only the nightly job ever executes, and **every** install — including every
per-PR CI install — pays for it. It also moves the version `sites/staging`'s
`@astrojs/cloudflare` peer-resolves `workerd` to, because pnpm picks the highest
`workerd` in the graph: the storefront build now runs the newer one. Overriding
`wrangler` back to the catalog version was tried and does **not** undo either
effect — `miniflare`'s exact `workerd` pin is what carries it — so the override is
deliberately absent rather than forgotten. The honest fix is upstream ranges or a
separate install for the nightly; until then the whole toolchain is enumerated in
`pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` so nothing about it is
implicit.

**How the tier is built.** `test/d1/describe-d1.ts` is a sibling of
`test/describe-each-dialect.ts`, not an extension of it. The split is structural:
the Node harness imports `better-sqlite3` and `pg` at module scope, and neither
exists inside `workerd`. What the two share is imported — the collection layout,
the document helpers, the fault-injection wrappers, the domain contract itself —
so only the test-surface plumbing is restated. The D1 files are named `*.spec.ts`
so the default project's `test/**/*.test.ts` glob cannot pick them up, and so
`scripts/pg-test-files.sh` never selects them.

The dialect comes from the host's own `createDialect` reading the `DB` binding out
of `cloudflare:workers` — the same call a real site makes — which makes this the
only tier that observes the host's wiring rather than Otta's. The schema comes
from the host's full `runMigrations` set, and the suite asserts that the revision
triggers really exist on D1 and really fire for a writer that supplies no
revision.

**What it proves.** The primitive suite (`updateIf`'s `RETURNING` and `json_set`,
`getVersioned`, `compareAndSet`'s revision assignment, `compareAndDelete`, the
query allow-list, the 100-row page ceiling) behaves on D1 exactly as it does on
better-sqlite3 and Postgres — case for case, no divergence. `inventoryStoreContract`
passes in full, with no skips — including the W1 crash-window case, which needs the
harness's `abandonPending` hook and silently asserts nothing without it.
Representative crash seams — (a), (c), (e) and the cross-SKU `commitMany` of (g) —
heal on D1 under the same real fault injection.

**What it does NOT prove, and where that is proved instead.** Miniflare runs a
test file in one `workerd` isolate on one thread, so concurrent promises
**interleave** but no two statements execute at the same instant. The race file
therefore runs the M=5/N=50 shape as an interleaving check — strictly stronger
than the sequential contract path, strictly weaker than simultaneity. Atomicity
under genuinely simultaneous writers is the **Postgres** tier's job, and it stays
the no-oversell gate. A staging site on real D1 has many isolates at once, so the
race this tier cannot run is real in production.

The crash tier is also not reused wholesale: the eighteen cases in
`test/inventory-crash-seams.dialects.test.ts` live inside a closure passed to
`describeEachDialect`, so running all of them on D1 means first splitting that
harness into a driver-agnostic binder plus two driver modules — a change to the
Node tiers, and its own change rather than a rider on this one. Seams (b),
(d-release), (f) and (g-`adoptMany`) are therefore Node-only today; they exercise
the same two injection mechanisms this tier already proves on D1, so what is
missing is logic coverage the Node tiers give on every commit — but it is a gap,
not a non-issue.

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

## Cart document model

`EmdashCartStore` implements the domain's `CartStore` over **one aggregate document
per cart**, plus one lookup collection the port signature forces.

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `carts` | cart id | `state`, `orderId`, `currency`, the `lines` map keyed by sku, the embedded mutation ledger, the denormalized `holdExpiresAt` | `state`, `holdExpiresAt` |
| `cart_mutation_index` | mutation idempotency key | `{ cartId }` — a locator, never the record | — |

**Three SQL features disappear into the shape.** `cart_lines (cart_id, sku)` UNIQUE
becomes the lines map being keyed by sku — structural, and not an index, which
matters because no tier here materializes one. The `cart_mutations` TABLE becomes
the embedded ledger, read and written in the SAME `compareAndSet` as the line it
records, so "claim the key, write the line, mark it completed" is one atom on the
cart side instead of three statements that can tear. And `reservations.expires_at
<= now` as a scan target becomes the declared `holdExpiresAt` field, because the
filter algebra has no OR and cannot reach inside a map.

**Why there is a second collection.** `recordedMutation(key)` and
`expireHold(reservationId)` are handed an identifier with no cart id, and an
embedded map cannot be queried by its keys. `cart_mutation_index` answers "which
cart claimed this key", for exactly the reason `reservation_index` exists on the
inventory side. It is written AFTER the ledger entry, never before, so it can never
name a cart that has no record; the reverse gap is harmless, because every method
that mutates is given the cart id directly and each of them re-ensures the locator.
`expireHold` reaches a cart in two hops — `reservation_index` gives the reservation's
reserve key, which IS the add's mutation key, which the locator maps to the cart —
and that second hop is also the sweep's SCOPING: a raw reserve has no cart claim,
so no locator, so the cart sweep can never reap it.

### The cart is the first cross-aggregate edge

Inventory keeps every invariant it owns inside one document. The cart cannot:
`upsertLine`, `adjustLine`, `removeLine` and `expireHold` each pair a cart write
with an inventory movement across two aggregates with no transaction between them.
Every one of them is therefore written as **intent claim → inventory op →
deterministic completion**, and the bracket is visible in the code rather than
implied:

1. `claimMutation` adds the key to the ledger with `completed: false`,
   create-if-absent by the map's own compare-and-set.
2. The inventory op runs through `InventoryStore` and nothing else — idempotent on
   its own terms (`reserve`/`adjust` by their key, `release` by the reservation's
   state machine), which is what makes step 3 safe to reach from any interruption.
3. The line write and `completed: true` land in the SAME compare-and-set.

Nothing here writes an inventory document. The store READS `inventory`,
`reservation_index` and `reservation_keys` — a line's live hold state and a crashed
claim's reservation id are facts about the other aggregate that the port asks this
one to report — and every WRITE goes through the injected store.

**The attach guard is a guarded WRITE, not a read.** `CartStore.upsertLine`'s
contract makes the deadline stamp and the attach guard the same act: the SQL did
both in `UPDATE reservations SET expires_at = :deadline WHERE id = :id AND
state = 'held'`, and zero rows was `HoldExpiredError`. A *read* of the hold cannot
substitute — the sweep can reap it between the read and the cart write, and the line
would be resurrected anyway — and dropping the stamp would break checkout outright,
because `adopt`/`adoptMany` are scoped `state='held' AND expires_at > :now` and would
classify every cart hold as lost.

`InventoryStore` declares no such method, and widening the port is a domain change
this package may not make, so the capability is adapter-local:
`HoldDeadlineStamper.stampHoldDeadline(reservationId, expiresAt)`, implemented by
`EmdashInventoryStore` as ONE guarded compare-and-set on the inventory document in
which the `state === "held"` precondition, the ownership check and the new deadline
commit together. It returns `false` — never throws — for an unknown, pruned or
adopted hold, and never touches a non-`held` one, so it can neither extend an
order's adopted deadline nor revive a reaped hold. `EmdashCartStore`'s constructor
asks for `InventoryStore & HoldDeadlineStamper`, which also keeps an adapter that
cannot supply it from being injected by mistake — and is what makes the two
tolerated `release` refusals in `expireHold` safe to recognize by TYPE, since the
errors that `release` can raise are then known rather than assumed.

Its `expiresAt` is **non-null**, narrowed from the first cut: a stamp is always the
attach of a line to a LIVE hold, and `adopt`/`adoptMany` are scoped
`expires_at > :now`, so a hold stamped with no deadline is exactly the hold checkout
would classify as lost. The domain never asks for one either — a cart line's
`expiresAt` is null only when its `reservationId` is, and such a line never reaches a
stamp — so the type is what keeps it that way.

It also refuses a reservation whose TERMINAL record has been written but whose hold
is not yet pruned — a state the ordered settle really passes through — so a cart can
never attach a line to units that are already spent. Same gate, same reason, as the
one `expireHold` applies before minting a fresh expiry token.

`upsertLine` and `adjustLine` both call it INSIDE the compare-and-set step, before
the cart write (the SQL's fixed step order, reservation before line), so the guard is
re-evaluated on every attempt rather than once outside the loop. The two call sites
treat a refusal DIFFERENTLY, and the asymmetry is the port's, not a shortcut:
`upsertLine` is ATTACHING a hold to a line, so a refusal is `HoldExpiredError`;
`adjustLine`'s line already references the hold, so there is nothing to guard,
refusing the cart write would gain nothing, and `HoldExpiredError` is documented as
`upsertLine`'s failure — the update use-case calls `adjustLine` outside any catch, so
throwing there would escape unmapped whenever a checkout or the sweep took the hold
between `inventoryStore.adjust` returning and the re-stamp. The SQL's adjust stamp
was likewise unguarded. `upsertLine` additionally re-reads the claim's `abandoned`
marker on every attempt, so a reaping that lands mid-retry is still seen — and that
marker is only a fast path, which is what makes bounding the abandoned records safe:
the guarantee is the guarded stamp, which refuses the same replay one round trip
later even with the marker evicted. The regression case is in `cart-fence.dialects.test.ts`: a real `addLine`, then
`adoptMany` for an order, asserting `adopted` and not `lost` — nothing in the cart
contract or the fences would notice the stamp going missing, and only that case does.

**The expiry choreography.** `expireHold` is the intent-claim of ADR-0019 §7.7: a
guarded flip that writes a once-only token — onto the LINE when there is one, onto
the outstanding CLAIM when the crash left none — then the release, then the removal.
The deadline is re-checked inside the flip, so a hold an active shopper reset
between listing and release is not reaped. Two rules make replay exact:

- the token is **never cleared**; the line is deleted by the completion, so a token
  on a still-present line means "an expiry was claimed and did not finish", which is
  precisely what a replayer must complete;
- only the writer that **minted** the token reports the reclaim, so a lazy read
  racing the sweep counts one expiry between them rather than two.

A **fresh** token is additionally refused whenever the reservation is already
terminal. That is the obligation the inventory tier hands every reaping path: the
terminal record is written before the hold is pruned, so a `committed` reservation
can leave a hold that still looks live, and returning its spent units would be an
oversell. An **existing** token is not gated — it means the expiry is owed its
completion.

**`adjustLine` converges, and the reconcile is a REPAIR.** The stored qty is
re-derived from the hold the store just read (ADR-0019's R5), and the hold can move
between that read and the cart write. So after the write the step goes round once
more: once the key is completed the mutation itself must never re-apply, but the
stored qty still owes the hold agreement, so a divergence is repaired IN PLACE with
the completion preserved. A bare retry could not do this — it would find `completed`
and hand back the stale line. Since a call's inventory movement always precedes its
cart write, whichever cart write lands last is followed by a pass that sees the
final hold; the loop ends the first time the two agree, inside the usual
compare-and-set budget. Pinned by `no-oversell-cart.pg.test.ts`'s convergence case,
which races two different-key adjusts on one line and asserts the pair agrees and
the units are conserved.

**The ledger is bounded — and the bound cannot drop a crash marker.** Three classes
of record, three rules. A record that is claimed and neither completed nor abandoned
is **never** pruned at any age: it is what tells a replayer to resume and what makes
a dangling hold listable, so dropping one would orphan real stock. `completed`
records keep the last `CART_MUTATION_LEDGER_SIZE = 64`, oldest evicted. `abandoned`
records — the audit trail of a reaped crash, whose units are already back and whose
claim is retired — keep the last `CART_ABANDONED_LEDGER_SIZE = 16`, so the second
thing that could grow without limit on a long-lived cart does not. The accepted
residual is
narrow and stated in the source: a replay of a key whose completed record was
evicted no longer short-circuits, so it answers with current truth instead of the
recorded qty. It is not a double-apply — the inventory ops are idempotent by key —
and reaching it takes 64 later mutations on ONE cart between a request and its retry.

**`holdExpiresAt` is a candidate filter, deliberately.** The SQL predicate was an OR
of a stamped-deadline arm (`expires_at <= now`) and a crashed-claim arm
(`expires_at IS NULL AND created_at <= cutoff`), against two different instants. The
filter algebra has no OR, so both fold into one indexed `<= now` and the exact
per-arm predicate is re-applied to the fetched document — an outstanding claim
contributes its `claimedAt`, which is always in the past. A cart can therefore be
listed and yield nothing, which costs a read and changes no answer. `listExpired`
pages, because the host clamps `limit` at 100.

### Cart crash seams proven

`test/cart-crash-seams.dialects.test.ts` opens each gap on real storage. Four of the
seven cases INJECT a fault with the shared helper — (b) through (e) let the real
writes before the gap land, throw where the process would have died, read the
documents back, and only then replay. The other three do not need to: (a) stops
after a real `claimMutation`, which IS the whole of the first step; (f) builds the
terminal-record-before-prune state with one direct conditional write; (g) asserts a
typed error rather than a crash. The file says so, rather than claiming otherwise:

- **(a) the claim landed, the inventory movement never ran** — the record is
  incomplete, no line, no stock moved; the replay resumes and decrements once.
- **(b) the reserve landed, the completion never did** — the units are gone and the
  hold is live with NO line; the replay attaches the SAME hold without a second
  decrement. A store that wrote the line outside the completion fails here.
- **(c) `expireHold` crashed after the once-only flip** — the token landed and
  nothing else: line still there, stock still off the shelf. The replay completes it,
  returns the stock exactly once, and reports `false` because it did not mint.
- **(d) `expireHold` crashed after the release** — the hardest: the stock is already
  back while the line is still visible. The completion is re-runnable, the line goes,
  and the stock does not come back twice.
- **(e) `checkout` crashed after the cart flip** — both fields landed together, so a
  `checked_out` cart with a null order id is unreachable through the port, and the
  replay is a benign `false` that never rewrites the id.
- **(f) a hold left live after its reservation went terminal** — not reaped, the
  spent units stay spent, and the line survives on purpose: the per-id commit/prune
  is the sweeper's, not something the cart may force.
- **(h) a settled-but-unpruned reservation** — the stamp refuses it even though the
  hold still reads `held`, so no line can be attached to spent units.
- **(g) a release the cart may not perform** — a typed `ReservationNotReleasableError`
  the expiry can classify, rather than a bare `Error` a caller would have to match by
  message.

## Order document model

`EmdashOrderStore` implements the domain's `OrderStore` over **one aggregate
document per order**, plus one claim collection the idempotency key forces.

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `orders` | order id | the header, the `readonly items` snapshot, `totals`, the ship-to, the append-only `events`, the first-wins `emailOutbox`, the `payments`/`refunds` ledgers, the three hold intents, and the denormalized `customerKey`/`buyerRefLower`/`searchKey`/`emailDueAt`/`holdsPendingAt` | `state`, `createdAt`, `customerKey`, `buyerRefLower`, `searchKey`, `emailDueAt`, `holdExpiresAt`, `holdsPendingAt`, `[state, createdAt]` |
| `order_keys` | order idempotency key | the claim (carrying the whole prepared document), then its terminal record | — |
| `payment_refs` | payment provider reference | `{ orderId }` — the GLOBAL once-only claim for a capture | — |
| `refund_keys` | refund idempotency key | the claim (carrying the whole prepared refund row), then its terminal record | — |
| `order_sku_index` | `${foldedSku}:${orderId}` | `{ sku, orderId, createdAt }` — the DERIVED pointer the search's line-sku arm reads | `[sku, createdAt]` |
| `outbox_keys` | outbox entry id | `{ orderId }` — which order document holds that email-outbox entry | — |

**Two corrections to ADR-0019 §4, to be recorded when that ADR is next amended.**
First, `payments.provider_ref` UNIQUE was a GLOBAL constraint, and the ADR maps it
onto "the provider reference keys the entry inside `payments[]`" — a per-ORDER
dedupe. A redelivery routed at the wrong order id would be recorded twice, once per
order, and `Σ captured` is the refund ceiling; so the replacement is a claim
document, `payment_refs/{providerRef}`, and a reference already held by another
order is refused with a typed `PaymentRefConflictError` rather than recorded.
Second, per-order NOTES do not belong in this document: a note is operator-supplied
free text with no natural bound, so embedding it would make the size of the hot
money-path document a function of how much support wrote about the order. INC-B8's
`EmdashOrderNotesStore` gets a child collection instead,
`order_notes/{orderId}:{noteId}` indexed on `orderId` — its port only reads notes by
order and appends one at a time, so nothing it does needs them in the aggregate.

**Two deviations from ADR-0019 §6, owed to the same amendment (director rulings).** §6.1
ratified a single prefix-only `searchKey`; this adapter ships a SECOND `startsWith` arm, on
`buyerRefLower`, so the buyer-reference half of the search survives as a prefix instead of
disappearing. And §6 rejected "issue two queries and merge"; this adapter does merge arms —
upheld as exact, because the port's `OrderListCursor` is a self-describing VALUE position
rather than an opaque per-query token, so each arm can contribute its own top `limit + 1`
and the count is taken by inclusion–exclusion over the same predicate. Both are recorded
here until §6 is amended.

**One intentional divergence from the SQL adapter's behaviour.** `markEmailSent` and
`rescheduleEmail` raise the typed, retryable `OutboxEntryUnlocatableError` for an entry id
no locator names and no bounded walk finds, where the SQL adapter's guarded `UPDATE …
WHERE id = :id` simply matches 0 rows and no-ops. The port's docstring describes the
no-op, so this is a deliberate difference and not a bug: on a document store a quiet return
there cannot be distinguished from a still-`sending` entry whose locator was lost, and that
one leaves a live lease to lapse into a double send. The port docstring will be tightened
with the ADR amendment.

**Two methods landed early, and one whole seam did.** `recordPayment` and
`flagReconciliation` are both on `settleOrder`'s path — between the paid flip and
`commitMany`, and on every anomaly branch — so the checkout races and five
`order-flow` cases could not run without them at INC-B2. `recordPayment` is the
claim-backed append above; `flagReconciliation` is the deliberately unguarded,
last-writer-wins field write ADR-0019 §7.13 describes. For the same reason the
**email-outbox lease** (`claimNextEmail` / `markEmailSent` / `rescheduleEmail`)
landed with the refunds increment rather than with the lists: the fulfillment and
cancellation specs both assert that exactly one shipped / cancelled email DRAINS,
which runs `dispatchOrderEmails`, so the lease is a dependency of that increment's
own gate. It is R2's design — the SQL's OR-and-negation claim predicate becomes the
single denormalized `emailDueAt` index, and the claim re-applies the same predicate
to the entry it picked inside one compare-and-set — and the lease's OWN contract
cases (the crashed-dispatcher and failed-send ones) are still the list increment's.

**The port is delivered across three increments, and the SHAPE was complete in the
first.** Creation, the guarded transitions, the audit spine, expiry and the hold
intents came first; refunds, the reconciliation resolution, fulfillment and
cancellation are described below. What remains is the lists, the search and the
customer view. Their FIELDS and their INDEXES were declared from the start —
`refunds`, `fulfillment`, `cancellation`, `reconciliationResolution`, `searchKey`,
`emailDueAt`, `customerKey` and the `[state, createdAt]` compound — so no increment
reshapes a collection that already holds live orders. Every method the last one owns
throws a typed `NotImplementedInIncrementError` naming it, and every contract case
that needs one is registered as a matching `test.todo` (see
`test/order-contract-b2.ts`, which is down to 39): a loud refusal and a visible
count, never a plausible empty answer.

**Six SQL features disappear into the shape.** `orders.idempotency_key` UNIQUE
becomes the `order_keys` claim document. `order_items` as a child table becomes the
`readonly items` array, written only by the creating write. `order_totals.order_id`
as PRIMARY KEY becomes a field, so one totals row per order is tautological.
`order_events` becomes the embedded append-only `events`, appended in the same
write as the flip it records. `order_emails_outbox (order_id, to_state)` UNIQUE
becomes the first-wins `emailOutbox` entry. And `hold_expires_at <= now` as a scan
target becomes the declared `holdExpiresAt` index, without which `listExpirable`
could not find work at all.

**Creation is a claim, then a create-if-absent, then a promotion — in that order.**
The claim carries the WHOLE prepared document, so a replayer finishes the create
byte for byte, reusing the recorded order id AND the minted line ids rather than
producing a second set. The promotion to `terminal` (which drops the payload)
happens LAST: a terminal key over a missing order would read as "already minted"
and lose the checkout. The one window — claim written, order document not yet
created — is healed by `createFromCart` and `getByIdempotencyKey` alike, which is
why the payload is carried at all.

**Snapshot immutability is structural rather than a discipline.** `items` is
`readonly OrderItemDoc[]` with every element field `readonly`, and every later write
is `{ ...doc, … }` — which carries that same array by reference. There is no code
path, and cannot be one without a compile error, that rewrites a price or a title
after purchase. `order-flow.dialects.test.ts` pins both halves: a product edit after
creation leaves the line untouched, and the array is identical (element ids
included) after a flip, a payment, an intent completion and a reconciliation flag.

**The transition is ONE write.** The guarded flip, the appended audit event and the
first-wins outbox entry are a single `compareAndSet` guarded on the revision AND on
`state === fromState` (plus, for expiry, on the deadline). So "flipped but no event"
is unreachable, the outbox once-only is per `(orderId, toState)` rather than per
event, and a lost race writes nothing at all. The SQL adapter got this from a
transaction; `order-crash-seams.dialects.test.ts` proves it here by PARKING that one
write and asserting all three facts are absent, then releasing it and asserting all
three are present — a stronger statement than aborting a transaction would be.

### The refund lifecycle

A refund is a claim, then ONE compare-and-set on the order document:

1. **Claim** `refund_keys/{refundIdempotencyKey}` create-if-absent, carrying the
   whole prepared ledger row — id, amount, `createdAt` — plus the order id and
   whether a full refund may flip the order.
2. **Arbitrate and append** in one write on `orders/{orderId}`: the ceiling
   `min(Σ captured, frozen total)` is computed from THAT document's own `payments[]`
   and `totals.total`, the ACTIVE capacity `Σ refunds WHERE status != 'voided'` from
   its own `refunds[]`, and the row is appended iff `activePrior + amount ≤ ceiling`.
3. **Promote** the claim to `terminal`, dropping the payload.

**The ceiling is computed INSIDE that write, never before it.** The SQL took a row
lock on `orders` — a real `UPDATE … SET updated_at` touch, not a self-assignment —
and summed under it, so two concurrent refunds could not each read the same headroom.
Embedding both ledgers in the document makes the revision do the same job: a peer that
committed between this read and this write makes the compare-and-set lose, and the
retry re-reads the sums it must respect. A ceiling taken from a pre-read would be the
one bug this shape exists to make impossible. `refund-race.pg.test.ts` is the proof
under contention; the frozen total is read from `totals`, never recomputed from
products, which is the snapshot invariant on the money side.

**`refund_keys` exists because the settle half of the protocol carries only the key.**
`finalizeRefund`, `voidRefund`, `markRefundUnverified` and
`getRefundByIdempotencyKey` are all key-only signatures, and an array embedded in an
order document cannot be found by a key without scanning every order. The claim is
also what replaces `refunds.idempotency_key` UNIQUE, and — as with `order_keys` — it
carries the payload so the one window is HEALED rather than tolerated: a crash between
the claim and the order write leaves a `claimed` key, and every path that meets one
re-runs the arbitration from the CARRIED intent, so the replay completes with the same
refund id instead of reserving twice. A REJECTED arbitration leaves exactly the same
state, deliberately: the SQL inserted no row when the ceiling refused a refund, so the
key stayed usable, and here the crash case and the rejection case are one code path.

**Capacity has four states (ADR-0019 R6), and all four live in that same write.**

| Status | Capacity | Set by |
|---|---|---|
| `recorded` | held; the only status that counts toward the `→ refunded` flip | `recordRefund` (the manual one-shot) or `finalizeRefund` |
| `reserved` | held — a slot won before the provider was called | `reserveRefund` |
| `unverified` | held, the safe direction, until a human re-checks the provider | `markRefundUnverified` |
| `voided` | RELEASED; the row stays as an audit record of the attempt | `voidRefund` |

`finalizeRefund` is status-guarded (`reserved` or `unverified` only) and **never
re-arbitrates** — its reservation already holds the capacity, so a finalize arriving
after a concurrent void of some other row still finalizes, which is the SQL's
semantics and the port's. A stray finalize over a `voided` row is a 0-row miss that
leaves the row untouched; a re-finalize with the SAME provider reference is a benign
duplicate; a DIFFERENT reference is the loud residual the use-case surfaces. A full
refund — the FINALIZED sum reaching the ceiling — drives `→ refunded` through the same
flip transform every other state change uses, in the same write as the row, so
"refunded with no refund recorded" is unreachable.

**Fulfillment and cancellation ride that flip, not a copy of it.** The tracking
envelope and the cancellation reason are passed to the guarded write as its
`envelope`, which is where the SQL's `extraSet` went: one guarded-flip
implementation, so a state change can never drift from the audit event and outbox
entry that accompany it. Cancellation also records the **release intent** — a
cancelled order no longer claims its holds — which the SQL adapter had no analogue
for; it is the same cross-aggregate bracket expiry uses, and `completeHoldRelease` is
guarded on `cancelled` as well as `expired`.

### The three hold intents

Adopting, committing and releasing an order's reservations writes N inventory
documents, and no primitive brackets them with the order write. Each is therefore
**intent → per-id idempotent write → completion**, with the intent recorded in the
order document by the same write as the state change that implies it:

| Bracket | Intent recorded by | Per-id write | Completed by |
|---|---|---|---|
| adopt | `createFromCart`, before the use-case's `adoptMany` | `adoptMany` (idempotent per reservation id) | `completeHoldAdoption` |
| commit | the `→ paid` flip, before settle's `commitMany` | the **singular** `commit` per id | `completeHoldCommit` |
| release | the `→ expired` **and `→ cancelled`** flips | `releaseAdopted` per id, order-scoped | `completeHoldRelease` |

**`holdsPendingAt` is how the sweeper FINDS the work.** An intent lives inside a
field, and the filter algebra can neither reach into one nor OR three together, so
the earliest `recordedAt` among the outstanding intents is denormalized onto one
declared index — the same device `carts.holdExpiresAt` is. It is recomputed from the
three intents on every write that touches one, never incremented, so it cannot drift
from what it summarizes, and it goes `null` exactly when the last intent closes.

**Each completion is guarded on the order's STATE, and that guard is not cosmetic.**
Adoption completes only while `pending`, commit only while `paid`, release only while
`expired` or `cancelled`; on any other state the intent is closed stamp-only, with no inventory call
and nothing reported lost. The adoption case is the sharp one: after a paid order's
holds are committed and pruned, `adoptMany` over the same ids reports every one of
them `lost`, so an unguarded completion would hand a sweeper a stock anomaly that has
not happened, on the happiest possible path. `order-crash-seams` pins it from that
side — it asserts what `adoptMany` WOULD have returned, then asserts the completion
returns nothing lost.

An intent whose `completedAt` is `null` is the marker that work is owed; each
completion is idempotent and callable by any replayer. The commit completion drives
the **singular** `commit`, not a re-run of `commitMany`, because `commitMany` skips
an already-`committed` id (ADR-0019 §2): a SKU caught between its terminal record
and its prune is finished by the singular call and by nothing else.

**One honest consequence.** On the happy path the settle use-case runs `commitMany`
itself and never tells the order store, so `holdsCommitted` stays outstanding until
a completion pass runs. That is the sweeper's work, and it is a no-op when it
arrives — both checkout races assert exactly that: `completeHoldCommit` after a
successful settle reports `lost: []` and closes the intent. `expire` and `cancelOrder` are the two
brackets the store completes itself, because both are the store's own methods — and if
that completion FAILS after the flip is durable, the failure is swallowed: the port
documents each return as "did this call win the guarded flip", so a throw would make a
sweep that really expired the order (or a cancel that really cancelled it) look like
one that did not. The intent is left outstanding (and `holdsPendingAt` keeps it
findable), and the reason is recorded on the order's reconciliation envelope.

**The commit completion folds two per-id errors into `lost`.**
`ReservationCommitLostError` (the hold was released or failed) and
`ReservationNotFoundError` (an id the order snapshot names and inventory has never
heard of) mean the same thing to the caller — a paid order with no hold, the
`COMMIT_LOST` anomaly. Letting the second escape would wedge the sweeper on that one
order forever and abandon the ids listed after it.

### The admin list, the search and the keyset cursor

This is where the document store diverges MOST from the SQL it replaces, so it is worth
stating exactly, including what an operator loses.

**The filter algebra.** `query({ where, orderBy, limit, cursor })` supports exact match,
`null`, `in`, the four range comparisons and a prefix — joined with `AND` only. There is
**no substring, no negation and no OR**, and a `where`/`orderBy` on an undeclared field
is a runtime `StorageQueryError` rather than a slow scan. The port's `listOrders`
predicate needs an OR in two places, and each is resolved differently.

**The search is an OR of three arms; all three are served, one of them narrowed.** The
port spells it as a folded order-id PREFIX **or** a folded `buyer_ref` SUBSTRING **or** an
exact folded purchase-time line sku.

| Arm | Served by | Status |
|---|---|---|
| order-id PREFIX (anchored, folded on both sides, a whole id is its own prefix, `""` matches everything) | `startsWith` on `searchKey` = `orderId.toLowerCase()` | **unchanged** |
| exact folded line sku, over the FROZEN lines, one row per order | `order_sku_index/{foldedSku}:{orderId}` — an equality on `sku`, keyset-ordered on the pointer's copy of `createdAt` | **unchanged** |
| `buyer_ref` **SUBSTRING** | `startsWith` on `buyerRefLower` | **NARROWED to a PREFIX** |

The third row is the ratified narrowing (ADR-0019 §6.1): the filter algebra has no
substring operator, so the arm is anchored. It is a prefix rather than nothing because the
index exists anyway for the customer key, and a prefix is what the arm is FOR — an
operator types an address, or the local part of one, and finds the order. What is genuinely
lost is the MID-STRING reach: a domain (`example.com`), or any fragment that does not start
the address, returns **nothing** — not an error and not a partial answer. The screen's empty
state says so at the UI increment, and widening it back out is a `[Domain]` change with its
own PR.

Four `orderStoreContract` cases stay registered as named todos until then, and they are
exactly the assertions a prefix cannot make: the mid-string fragment, a bare `%`/`_`, a
bare `\`, and `countOrders` taken under the substring predicate.
`test/order-store-contract-narrowed.ts` is the copy that holds them (43 of the suite's 47
cases run for real).

The metacharacter guarantees survive intact: the host escapes `%`, `_` and `\` before it
builds the `LIKE`, so a prefix search is literal, and the sku arm is an equality with no
pattern language at all.

**The sku arm cannot double-count, by construction.** Its documents are keyed by the
`(sku, orderId)` PAIR, so an order with two lines of one sku owns ONE pointer — the
port's "an order carrying two matching lines must appear once" becomes a property of the
document id rather than a de-duplication step someone can forget. `countOrders` adds the
sku set as a **set difference** (only the sku-matched orders no indexed arm already
counted, membership decided in memory from each document's own `searchKey` and
`buyerRefLower`), so a count can never disagree with the page it captions.

**The sku arm is keyset-bounded for the LIST and `O(matches)` for the COUNT, and the
ceiling is typed.** The pointer carries the order's frozen `createdAt` and the collection
declares `[sku, createdAt]`, so the list reads pointers newest-first and opens only the
`limit + 1` orders it could return — not every order that ever bought the sku. A COUNT has
no page to stop at, so it does resolve them all: the bound is
`maxListPages × LIST_PAGE_SIZE` pointers — **1000 × 100 = 100 000** by default — past which
the call raises `ScanPageLimitError` naming `maxListPages`, never a short count. A sku with
more matching orders than that wants the budget raised, and would want a materialized
counter first.

**The customer key stays a UNION, and it needs a second index.** ADR-0019 R3 collapsed
`customer_id = :id OR lower(buyer_ref) = :ref` into one `customerKey in [...]`, and handed
this increment the edge that narrows: an order owned by a customer id whose buyer
reference ALSO folds to the queried reference. **A contract case pins that edge** —
"listOrders customer key with a single half set filters on that half alone" requires a
`buyerRef`-only key to return the LINKED order too, whose `customerKey` holds its customer
id. So R3's conditional applies: the document carries a second declared index,
`buyerRefLower`, and the OR is resolved as **two indexed arms the adapter merges**. The
count takes them by **inclusion–exclusion** (`|C1| + |C2| − |C1 ∧ C2|`, the intersection
being one more AND clause), which is what keeps an order matching both halves counted
once.

**The cursor: the port's value position wins, the host's opaque token is ignored.** The
host mints an opaque cursor whose seek RE-READS the cursor row by id (`select … where
id = :cursorId`), so a deleted cursor row breaks it — and ADR-0019 §6.3 left the mapping
to this increment. The decision is **option (2), re-derive**: the port's
`OrderListCursor` is a value position (`{ createdAt, id }`) that describes itself, so the
adapter seeks with a COARSE `createdAt: { lte: cursor.createdAt }` on the declared index
and applies the exact `createdAt DESC, id DESC` tie-break in memory (a true keyset
tie-break needs an OR). Two consequences, both deliberate:

- **a deleted cursor row is not a paging fault.** The position still describes itself and
  paging continues from it. That is the opposite of the host token's failure mode, and it
  is the reason the mapping was chosen; `test/order-list-cases.ts` pins it, and no such
  case existed anywhere in the tree before;
- **it is what makes the merge exact.** Because "strictly after this position" is
  decidable for a document from ANY arm, each arm can contribute its own top `limit + 1`
  rows and the top `limit + 1` of the merge is the true page. Merging arms under an
  opaque per-query token could not do that, which is exactly why ADR-0019 §6 rejected it.

**Two orderings are in play, and the invariant that reconciles them.** The adapter's total
order is `createdAt DESC, id DESC` in **code-unit** order — that is the order the port's
cursor position is defined in. The HOST's `order by` breaks its `createdAt` ties on the
storage `id` COLUMN under the **database's collation**, and Postgres's default collation is
not code-unit order: it ignores punctuation at the primary level, so ids like `oa` and `o-b`
sort one way there and the other way here. That matters only where rows are dropped, so the
rule is: **an arm is drained to the end of its boundary TIE GROUP before anything is
sliced.** Both scans keep reading past `need` until `createdAt` changes, and only then does
`listOrders` sort in code-unit order and slice. Truncating at `need` in the host's row order
would let a tied row Postgres ordered differently fall off one page without appearing on the
next — a silent gap, on one dialect only. `test/order-list-cases.ts` pins it with four
orders at one instant and ids `oa`, `o-b`, `o-c`, `o-d` paged one at a time; with the drain
removed that case fails on Postgres (dropping `oa`) and passes on SQLite, whose BINARY
collation happens to agree with code units.

The host's `limit` clamp (50 default, 100 ceiling) is invisible to the caller: the
adapter pages at 100 internally until it has `limit + 1` rows, and a page budget
exhausted with pages still unread is a typed `ScanPageLimitError` (`maxListPages`), never
a silently short list.

**`listForCustomer` and `linkGuestOrders`.** The first is the SQL's `customer_id = :id`
equality — not the list's union — read off `customerKey` with an in-memory re-check, and
ordered `createdAt ASC, id ASC`. The second is `lower(buyer_ref) = :folded AND
customer_id IS NULL`, collected in full and then rewritten one compare-and-set at a time,
re-applying the guard inside each write. It **rewrites `customerKey`** (R3) — without
that the customer filter would stop finding the order the moment it was linked — and
leaves `buyerRefLower` frozen alongside `buyer_ref` itself.

**Pre-INC-B4 documents carry no `searchKey` and no `buyerRefLower`.** A `startsWith` or an
equality over SQL NULL is NULL, so such an order is unreachable by the arms that read those
fields (it is still listed, filtered, counted and paged like any other). **No backfill is
owed, because nothing is deployed** — this collection has never held a production order.
Both fields are typed `string | null` and defaulted in `normalizeOrderDoc` so the value is
DEFINED and round-trippable through a compare-and-set, not so that anyone must migrate data.
The same applies to the by-sku pointer's `createdAt`.

### The outbox locator

The dispatcher settles a row by ENTRY id alone, and an entry embedded in an order
document cannot be found by one. `outbox_keys/{entryId} → { orderId }` is the locator —
the same device `payment_refs` and `refund_keys` are — and it replaces the `emailDueAt`
index walk the transitions increment shipped as known debt.

It is a **second** document, so it is bracketed rather than atomic, and the bracket has a
direction: the locator is written **after** the flip that enqueued the entry. The only
reachable tear is therefore "entry exists, locator does not", and the settle path **heals**
it — one bounded walk of the same `emailDueAt` index, then the locator is written so the next
settle is a single `get`. The reverse ordering would leave a locator pointing at an entry
that does not exist, which nothing could heal. `maxOutboxPages` bounds only that fallback.

**An unresolvable entry id is LOUD, and that is a deliberate correction.** A claimed entry
is in the `emailDueAt` index by construction — but the index CHURNS under concurrent claims
and settles, so a walk really can pass a row another dispatcher is moving. Returning quietly
when the walk finds nothing would conflate two states that are not equivalent: an
already-drained entry HAS a locator (so it never reaches the walk, and its settle is a
guarded no-op), while an entry whose locator was lost and whose row the walk missed is still
`sending` — and a quiet return there leaves a live lease to lapse and the message to be
claimed and sent a SECOND time. So the walk is followed by one more locator read (a peer
completing the same heal is the likeliest explanation), and if that is still empty the call
raises the typed, retryable `OutboxEntryUnlocatableError`. Nothing was written, so a retry
or the next dispatcher tick is the remedy.

**Both pointer collections read their refusals back.** `compareAndSet(id, null, …)`
returning `applied: false` means the row exists, which is the ordinary outcome of a replay
or a peer — but "idempotent" is a claim about the CONTENT, so the incumbent is read and its
`orderId` compared. A disagreement is an id collision and raises
`DerivedPointerConflictError`: adopting it would mis-route a settle onto another order's
document, or make the sku search answer with it.

The write stays guarded on `status === "sending"`: only a CLAIMED entry is settleable, so
a double settle — or a settle of an entry nothing ever minted — is a no-op, which is what
the port's `void` return makes the correct outcome rather than a lost write.

**The by-sku index heals the same way, in the other direction.** It is written after the
order document and **before** the key is promoted, so a crash between them leaves a
`claimed` key and any resolve of that key re-asserts the pointers; each is
create-if-absent on its pair, so the heal writes one document however many times it runs.
**The heal fires only on a key REPLAY** (anything that goes through `#resolveKey`): a
crashed create whose pointer never landed and whose key is never replayed stays a residual
for the sweeper, not something a read repairs.

### Order crash seams proven

`test/order-crash-seams.dialects.test.ts` opens every window on real storage. Twelve of
the fourteen cases INJECT a fault with the shared helper — the writes before the gap land
for real, the write at the gap throws or is parked, and the documents are READ BACK
before anything replays, so what the replay heals is the state the store really leaves
behind. The remaining two inject nothing and say so: they are COMPLETION-ROBUSTNESS
cases, driving a completion against a state the ordinary path reaches on its own (a
paid order, an id inventory never knew) to pin what it must NOT do. The same split the
cart section draws, for the same reason:

- **(inject) the key claim landed, the order document did not** — the replay completes it
  from the payload, with the SAME line id, and promotes the key.
- **(inject) the order document landed, the key was never promoted** — an ordinary read
  heals it, and exactly one order exists for the key.
- **(inject) a partial `adoptMany` across three SKUs** — one adopted, two still held; the
  completion re-adopts idempotently and closes the intent, and a second completion
  is a no-op.
- **(inject ×2) a partial commit, one id terminal-committed with its hold unpruned** — the state
  is READ BACK before the replay (all three reservations `committed`, two holds still
  live), then the singular per-id completion finishes the set and every hold is
  pruned. That last assertion is what fails if the completion ever re-ran
  `commitMany`, which `continue`s an already-committed id without touching the
  aggregate — leaving a live hold over spent units.
- **(completion robustness) adopt completion on a paid order** — stamp-only,
  `lost: []`, stock untouched, against an `adoptMany` that would have reported every id
  lost. No fault is injected: `markPaid` + `commitMany` is the ordinary path there.
- **(completion robustness) commit completion on an unknown reservation id** — folded
  into `lost`, intent still closed, sweeper not wedged. Nothing is injected either: the
  order is minted naming an id inventory has never heard of.
- **(inject, parked) the transition parked** — none of flip, event, outbox has landed; released, all
  three have, and a lost second flip adds nothing to either array.
- **(inject ×2) expiry crashing after the flip, and after one release** — the release intent
  survives, the completion returns each sku's units exactly once, and a late sweep
  finds nothing owed.
- **(inject) a refund claim landed, the order write did not** — the key answers NULL (so
  the use-case re-reserves rather than resuming), and that re-reserve COMPLETES the claim
  with the SAME refund id; a further replay is the benign duplicate, and the ledger holds
  one row throughout.
- **(inject) a reserve whose finalize crashed** — the row is still `reserved` with no
  provider reference stamped, and the status-guarded replay finalizes it exactly once
  (a second same-ref finalize is benign and writes nothing).
- **(inject) a void whose write crashed** — the reservation is still holding the whole
  ceiling (a peer's full refund is refused), the replay wins the guarded flip, a second
  void is a 0-row no-op, and a fresh refund then reclaims the released capacity.
- **(inject) a cancellation crashing after the flip** — the cancel still reports
  `cancelled` (the flip is durable), the release intent is owed and findable, the
  failure is on the reconciliation envelope, and the completion returns the units once.

### Measured document size

A three-line order with a full ship-to snapshot: **2,237 B on creation**, **4,081 B
after five transitions** (five audit events plus five outbox entries), and **5,164 B
with two captured payments and three refunds on top of those five transitions** —
measured on the sqlite tier, `JSON.stringify(doc).length`. The `order_keys` document
is **109 B** once terminal, and roughly the size of the order itself (~2.3 KB) for
the instant it is a claim carrying the payload; a `refund_keys` document is **159 B**
once terminal, and ~400 B while it is a claim carrying the prepared row.

The 4,081 B figure is 22 B above the one the transitions alone used to cost, because
`emailDueAt` is now a populated timestamp rather than `null` once an outbox entry
exists. (Two earlier-recorded figures, 2,207 and 4,029 B, read 30 B low against this
same case on the tier it was re-measured on; the creation path has not changed.)

All three figures are asserted, not remembered: `order-flow.dialects.test.ts` builds
that order, prints the sizes and holds them under an **8 KB cap** — unchanged, since
the busiest shape measured is still under two thirds of it — so a row-size regression
(an unbounded ledger, a re-embedded snapshot) fails a test instead of surfacing as a
slow read.

`events` is deliberately UNBOUNDED. It is the audit spine the port promises in
chronological order, and dropping an entry would be a lie about an order's history;
the bound is the state machine itself, which admits at most nine transitions per
order, so the growth above is the whole of it (~370 B per transition, event plus
outbox entry). `payments` and `refunds` are bounded the same way — by how many times
money can move on one order (~180 B per capture, ~220 B per refund row, measured on
the case above). The one ledger with no natural bound, per-order notes,
is therefore NOT in this document at all (see the ADR corrections above).

## Contention budget

R2 has no structural fix — the aggregate is written by read-modify-write, so a hot
SKU retries — which makes the measured retry depth a **permanent** budget rather
than an interim number. `test/inventory-crash-seams.dialects.test.ts` exports
`CAS_ATTEMPT_BUDGET` and asserts it on Postgres:

**Contention budget: measured max CAS attempts M=5/N=50 (20 loops) → 5–6,
M=1/N=100 → 2; budget asserted at 8 (< `CAS_MAX_ATTEMPTS` = 24).**

**`CAS_MAX_ATTEMPTS` is 24, and it was 12.** The ceiling has to cover the WORSE of the
two document bounds, and the refunds increment showed that it did not. The inventory
bound is the units: at most M writes succeed before the guard turns every remaining
caller into a clean `OUT_OF_STOCK`, so depth tracks M. The ORDER-document bound is
money movements, and it is roughly `2 × (refunds that fit) + 1` — each gateway refund
writes twice (reserve, then finalize) and the ceiling-reaching one folds the
`→ refunded` flip into its second write — so a 1,000-cent ceiling refunded 100 at a
time is 21 peer writes on one document. The extra attempts only buy jittered backoff
(capped at `CAS_MAX_DELAY_MS` = 50 ms per sleep) on a path that would otherwise raise
`StorageContentionError`; no invariant depends on the number, and every per-shape
assertion bounds the measured depth AT or BELOW the constant, so raising it cannot
turn a failing shape green. The one hand-set budget, `CAS_ATTEMPT_BUDGET` = 8, is
unchanged.

The ORDER races measure the same budget on a different shape, and one of them sits
closer to the ceiling: single-line checkout (M=5, N=40, 8 loops) → **6–7**, and
multi-line checkout (M=8/sku, N=10 carts, 3 lines, 6 loops) → **9–10** of 24. The
multi-line figure is higher because each cart contends for three aggregates at once
and its three adds race each other as well as the crowd. Both files assert only
`< CAS_MAX_ATTEMPTS`, deliberately: tightening the order races to the inventory
suite's 8 would fail on the shape that legitimately reaches 10, and loosening the
ceiling itself would hide a real regression.

The REFUND races measure the same budget on the order document. Ten partial refunds
fitting under one ceiling (N=20 callers, 100 each against 1,000, with injected gateway
latency so the reserve and finalize legs interleave) measured a depth of **11** — under
the old ceiling of 12 by one attempt, which is what moved the constant; the
full-ceiling shapes measure 2, because a loser is refused by arbitration before it
writes anything. Every refund race now ASSERTS the depth against `CAS_MAX_ATTEMPTS`
rather than only printing it. The theoretical worst case for the gateway-partial shape
is the `2 × 10 + 1` above; an exhausted budget there is still a typed retryable refusal
and never an over-refund, because a losing writer never applies its update.

**The embedded ledgers have a practical bound, and it is the row budget, not the
algebra.** A three-line order with a full ship-to and five transitions is 4,081 B, and
each further money entry costs ~180 B (a capture) to ~220 B (a refund row) — so roughly
**14 more ledger entries** fit on that order before the 8 KB document budget the size
test asserts. That is far beyond what the state machine and a real refund ceiling admit
on one order, which is why the ledgers are embedded and per-order notes are not.

Both inventory figures are stable across repeated runs, and both sit at M+1: only M writes can
succeed before the guard turns every remaining caller into a clean `OUT_OF_STOCK`
with no write at all, so a writer loses at most M times. Depth tracks the UNITS on
one document, not the size of the crowd.

The merchant shape is the exception worth naming: twenty guarded `removeStock`
calls racing twenty `reserve`s on one document — where a REFUSED removal still
writes its ledger entry, so the writes are not bounded by the units — is the one shape
that reached the old ceiling and raised `StorageContentionError`. It is also the shape
the raised ceiling most visibly served: same depth-plus-a-little, no typed failures.

**Removal shape (20 removals racing 20 reserves on 12 units, 15 loops = 600 calls):
measured max CAS attempts 15, measured typed contention failures 0; asserted at
`<= CAS_MAX_ATTEMPTS` and `<= 90` (15% of the calls) respectively.** Both numbers moved
when the ceiling did: at 12 this shape sat AT the ceiling and raised 11–29 typed
contention failures per run, and at 24 it goes two or three attempts deeper and raises
none. That is the whole of what the extra attempts buy — callers who were being told
"too busy" are now served — and both assertions are upper bounds, so they held across
the change without being touched.

Per-shape depth and contention, as the suite reports them per case:

| shape | max CAS attempts | typed contention failures |
|---|---|---|
| restock same key ×24 | 2 | 0 |
| removeStock same key ×24 | 2 | 0 |
| restock +10 racing 40 reserves on 5 units | 13 | 0 |
| restock then 40 reserves on 15 units (sequenced) | 12 | 0 |
| 20 removals racing 20 reserves on 12 units | 15 | 0 |
| 10 partial refunds fitting one ceiling (N=20, gateway latency) | 11 | 0 |
| N=24 full refunds on one ceiling | 2 | 0 |
| N=30 reconciliation resolves on one flagged order | 2 | 0 |

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
