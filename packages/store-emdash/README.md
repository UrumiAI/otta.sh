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

The other typed refusal that boundary owes a mapping is
`SettingsMutationSupersededError` (see the settings section): **409**, and
**non-retryable** — re-issuing the same idempotency key can never succeed, because
the revision it is pinned to will not come back. The remedy the response should
carry is a fresh key, which is a new decision against the current state. Recorded
here as a forward note for the in-process client, alongside the 503 above.

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

**The search is an OR of three arms, and all three are served.** The port guarantees a
folded order-id PREFIX **or** a folded `buyer_ref` PREFIX **or** an exact folded
purchase-time line sku — the ratified narrowing (ADR-0019 §6.1), which is where the
port's contract now sits rather than at the unanchored substring it once spelled.

| Arm | Served by | Status |
|---|---|---|
| order-id PREFIX (anchored, folded on both sides, a whole id is its own prefix, `""` matches everything) | `startsWith` on `searchKey` = `orderId.toLowerCase()` | **unchanged** |
| exact folded line sku, over the FROZEN lines, one row per order | `order_sku_index/{foldedSku}:{orderId}` — an equality on `sku`, keyset-ordered on the pointer's copy of `createdAt` | **unchanged** |
| folded `buyer_ref` **PREFIX** (anchored, a whole address is its own prefix) | `startsWith` on `buyerRefLower` | **unchanged** — this store is why the arm is anchored |

The third row is the ratified narrowing (ADR-0019 §6.1): the filter algebra has no
substring operator, so the arm is anchored. It is a prefix rather than nothing because the
index exists anyway for the customer key, and a prefix is what the arm is FOR — an
operator types an address, or the local part of one, and finds the order. What is genuinely
lost is the MID-STRING reach: a domain (`example.com`), or any fragment that does not start
the address, returns **nothing** — not an error and not a partial answer. The screen's empty
state says so at the UI increment, and widening it back out is a `[Domain]` change with its
own PR.

All 47 `orderStoreContract` cases run for real here, on every tier, with no copy and no
todo: the contract asserts the anchored prefix, the exact sku and the literal
metacharacters — the floor every adapter must reach — and deliberately does NOT assert
that a mid-string fragment fails, so an adapter serving the unanchored superset stays
conformant too. This store's own narrower statement, that a mid-string fragment finds
NOTHING, is pinned where it belongs: `test/order-list-cases.ts`, beside the rest of the
document model's list and search statements.

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

## Product-commerce document model

`EmdashProductCommerceStore` implements the domain's `ProductCommerceStore` over
**one aggregate document per product, with its variants embedded in it**, plus one
claim document per live sku. It also READS and WRITES the `inventory` collection
above — the stock projections and the sku-rename carry — so a caller must bind both
layouts.

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `product_commerce` | product id | every `ProductCommerce` field, the embedded `variants` map, the publish-gate watermark, the recorded rename carries, and the denormalized `lifecycle`/`publishKey` | `productId`, `lifecycle`, `publishKey`, `productKind`, `taxClass`, `createdAt` |
| `sku_owners` | sku | `{ ownerKind, ownerId, variantKey, live }` — the live-sku uniqueness claim | `sku` (unique; declared, **not** the enforcement) |

**Four SQL mechanisms become document writes.**

| The SQL | Here |
|---|---|
| `INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE <replay guard AND watermark guard>` | one `compareAndSet` whose guards are computed against the value it just read |
| the compare-and-set on `updated_at` plus its zero-row classifier | the same classifier, in the same order, inside that write |
| two **partial** unique indexes (`WHERE deleted_at IS NULL`, `WHERE orphaned_at IS NULL`) plus reciprocal cross-table checks | the `sku_owners` claim, whose `live` flag IS "unique among live rows only" |
| a written-down lock order `product_commerce → inventory (sku order) → product_variants` | embedding, plus the intent-claim carry — there is no lock, so there is no order to get wrong |

### Two deviations from the design's index table, both forced

**`active` is filtered through a text mirror, `publishKey`.** A `where` value is bound
as a parameter and better-sqlite3 binds only numbers, strings, bigints, buffers and
null — a boolean throws `SQLite3 can only bind …` before any comparison runs. So the
gate is stored twice: `active` is the boolean the port reads back, `publishKey` is the
indexed text the filter binds, and `publishKeyFor` is the only thing that derives one
from the other.

**`titleLower` is NOT declared.** The port's `search` is a case-insensitive SUBSTRING
on the title, and the filter algebra has no substring operator, so no declared index
could serve it and declaring one would be a read contract for a query that is never
issued. The title half of the search is resolved in memory over the rows the indexed
axes already narrowed.

**The full difference from ADR-0019 §4's list, so nothing is undercounted.** The design
names `sku`, `active`, `taxClass`, `titleLower`; this store declares `productId`,
`lifecycle`, `publishKey`, `productKind`, `taxClass`, `createdAt`.

| Field | Change | Why |
|---|---|---|
| `taxClass` | kept | `countByTaxClass`'s only predicate |
| `active` | replaced by `publishKey` | a boolean cannot be bound as a filter value on one dialect (above) |
| `titleLower` | DROPPED | the search is a substring and the algebra has none (above) |
| `sku` | DROPPED | nothing queries `product_commerce` by sku. Live-sku uniqueness is the `sku_owners` claim, reached by document id, and a variant's sku is not a field of its product document at all — an index on the product's own `sku` column would answer half the question and would be a read contract for a query never issued |
| `lifecycle` | ADDED | the tombstone axis, as three states rather than a nullable column (below) |
| `productKind` | ADDED | `ProductListFilter.productKind` is an equality the list pushes down |
| `createdAt` | ADDED | the admin list ORDERS by it, and ordering on an undeclared field throws exactly as filtering on one does |
| `productId` | ADDED | the two batch reads fetch a whole batch with one `productId in [...]` query rather than a `get` per id |

### `lifecycle` is a three-state discriminator, and a variant may land first

`content:afterSave` and the repeater's rows arrive as independent calls, and the port
requires a variant to land even when its product row has not. So the document is
created by whichever write arrives first and `lifecycle` says whether a PRODUCT ROW
exists: `"absent"` is a document that holds only variants, and `getByProductId`
answers `null` for it. That is also what keeps such a shell out of every list — and
why the tombstone axis is this field rather than a nullable `deletedAt`: the archive
view needs "deleted is not null", the filter algebra has no negation, and a nullable
column cannot carry the third state anyway.

### The sku-rename carry, as an intent-claim

`src/sku-stock-transfer.ts`. A rename moves units between two inventory documents
while the decision lives in a third, and nothing here writes two documents at once.

1. **Decide** (`prepare`): refuse while a live hold names the source
   (`SkuHeldStockError` — a read of the document the carry is about to write), then
   CLAIM the target create-if-absent (`SkuStockConflictError` on a lost claim). Holding
   that claim is what guarantees the move cannot be refused for occupancy later.
2. **Commit the product write**, recording the carry it owes in the SAME
   `compareAndSet` — `pendingRenames`, a map keyed by the carry's token.
3. **Move** (`move`): one `compareAndSet` on the source sets `onHand → 0` and stamps
   `transferOut: { token, toSku, qty }`; the target adds `qty` iff its
   `appliedTransfers` ring lacks the token; the source clears the stamp; the pair of
   `rename_out`/`rename_in` audit entries is written into `inventory_movements` under
   `rename:`-prefixed ids that the movement claims' replay paths never address.

**The order of 2 and 3 is load-bearing, and was learned from a failing race.** A carry
that runs BEFORE its product write can have that write lose a compare-and-set, leaving
the units under a sku the product does not hold — and while such a carry is in flight
the source reads `0`, so a concurrent writer renaming the same product carries nothing
and strands them for good. A compensating reversal does not fix it: the transient zero
is already visible to a peer that has decided how much to move. The product document's
own compare-and-set is therefore the mutual exclusion.

**The token is DERIVED** from the write's idempotency key plus both skus, so a replay
recomputes it and adds nothing twice. A freshly minted token would make every retry a
second transfer.

**What the lock order actually left open, corrected against the spec.** The SQL package
had NO `40P01`/`40001` retry anywhere: deadlock was avoided by acquiring the two
inventory rows in sorted sku order, and that avoidance was recorded as INCOMPLETE — the
product-side writers took a unique-index lock ahead of the inventory locks, so two
products renaming onto each other's skus could still deadlock, and a lock-order deadlock
was never mapped to a typed error. It would have reached a merchant as a 500 on a legal
edit. There is no lock here at all, so the residual goes with the mechanism rather than
being closed: the two crossing-rename cases in `variant-sku-rename-race.pg.test.ts`
assert `40P01` never surfaces, and they now pass by construction. A `40001`
serialization abort from a host above READ COMMITTED is still retried, by `cas-retry.ts`,
exactly as it is for every other document write in this package.

### What the carry cannot make atomic, stated exactly

- **A hold arriving between step 1 and step 3 changes the held-stock semantics, and this
  is a deliberate weakening.** The SQL adapter refused ATOMICALLY: the source row was
  locked before the hold count was read, so a reservation could not land inside the
  window and the whole rename rolled back. Here the product write has already committed
  by the time the move runs, so a hold arriving in that window leaves the rename
  COMMITTED with the carry OWED. What an observer sees is a product whose sku is the new
  one while its stock is still under the old one — a phantom out-of-stock on the target,
  never an oversell, because no unit is ever counted twice and the source's units stay
  exactly where a release of that hold expects them. It is completed by
  `completeRecordedRenames(productId)`, which the sweeper runs and which ANY later write
  on the product runs first, and a NEW rename of the same owner is refused with that same
  `SkuHeldStockError` meanwhile. The contract pins only the SEQUENTIAL refusal, which is
  unchanged and green; the window is reachable only by a concurrent reserve, and
  `product-commerce-crash-seams.dialects.test.ts` drives it deliberately.
- **The SOURCE sku's claim is held until the carry is terminal.** Releasing it while the
  carry is owed would leave a sku that still holds units looking free, and a first-sku
  assignment ADOPTS an existing inventory document by design (THE FIRST-SKU ASYMMETRY) —
  so a different owner would take those units and the eventual completion would zero them
  out from under it. The claim is released only by whoever finishes the move.
- **A contended target claim.** "This owner won the sku's claim while the target had no
  inventory document, and by the time the document was claimed one existed" has two
  producers: a second call renaming the SAME product onto the SAME sku (legitimate) and
  `seedOnHand` slipping into a one-write window (a genuine occupancy). They are
  indistinguishable from the documents, so the write waits `TARGET_CLAIM_CONTENTION_ATTEMPTS`
  = 6 jittered attempts — the peer case resolves within a round trip — and refuses
  `SkuStockConflictError` if it does not.
- **An abandoned claim, and its inventory residue.** A call that takes a sku claim and
  then never commits gives it back in a `finally`. A process that DIES in that window
  cannot, and both residues are durable: a live claim nothing backs, plus — for a rename
  — an empty inventory document under the target, which "occupied is occupied" would
  otherwise refuse forever. So the claim is a LEASE, and a live claim held by another
  owner resolves to one of four states:

  | `ClaimStatus` | Meaning | Outcome |
  |---|---|---|
  | `held` | the owner's live product row (or non-orphaned variant) carries this sku | `SkuConflictError` |
  | `owed` | the owner no longer carries it but still OWES a stock carry away from it | refused, at any age |
  | `in-flight` | nothing backs it, and it is younger than the lease | refused |
  | `abandoned` | nothing backs it, nobody owes it, and it is older than the lease | taken over |

  A takeover also withdraws the empty inventory document, and only that one, which is
  what `SkuOwnerDoc.createsTarget` records; a seeded empty row is never withdrawn, so
  "occupied is occupied" still holds for real stock. `CLAIM_ABANDON_AFTER_MS` defaults to
  60 s and is overridable per store.

  **What a merchant sees.** Retrying a rename whose first attempt died mid-write is
  refused — `SKU_TAKEN`, or `SKU_STOCK_CONFLICT` where the target already had units —
  for up to the lease, and then succeeds. Nothing else is affected: a sku nobody was
  half-way through claiming behaves exactly as before.
- **A writer overtaken while it was stalled.** The claim is proven when it is TAKEN, and
  the product document commits later; a writer that stalls past the lease between the two
  is legitimately overtaken, and its product compare-and-set — which guards the product
  document's revision — can see nothing about that. So the claim is RE-ASSERTED
  immediately before the commit, by a compare-and-set at the revision the call last saw:
  one write that both proves the claim is still ours and restarts the lease from the
  commit attempt, so a merely slow writer (a retry storm) is never reaped for being busy.
  It runs on every attempt of the retry loop. A claim that has gone refuses typed and the
  product document is not written.

  **The residual, stated exactly.** Two-document atomicity does not exist here, so this
  closes the window down to the gap between two ADJACENT statements — the heartbeat and
  the product compare-and-set — and a pause of the full lease length in that gap would
  still be overtaken. It is the residual every lease scheme has. 60 s is what makes it
  unreachable in practice: the whole retry budget is 24 attempts with each sleep capped at
  50 ms, under two seconds end to end, so the pause would have to be thirty times the
  entire budget and land between two consecutive awaits.

  **Clock skew.** The lease compares the READER's clock against the CLAIMANT's
  `claimedAt`, so workers whose clocks disagree measure different ages. The re-assertion
  decides who loses, and it is always the slow WRITER rather than the data: an early
  takeover moves the claim's revision, so the original writer's pre-commit
  compare-and-set fails and it refuses typed instead of committing a second live row.
  Skew costs a merchant a spurious retry, never a sku with two owners.

  **One residue an overtaken writer can leave.** If its empty target inventory document
  had already landed before the takeover, it survives under the NEWCOMER's sku, and no
  claim can withdraw it afterwards: the withdrawal is gated on the claim that created it,
  and that claim is gone. Nothing is lost — the document holds no units, and it is exactly
  what `seedOnHand` would have created for that sku anyway. The only visible effect is
  that a THIRD writer renaming onto that sku is refused `SkuStockConflictError` on an
  occupancy nobody chose, until the newcomer stocks the sku (at which point the document
  is legitimately occupied) or a sweep clears it.
- **The audit trail of a swept carry.** A carry finished by
  `completeRecordedRenames`/`completePendingSkuTransfer` writes NO `rename_out`/`rename_in`
  pair: the entry ids derive from the write's idempotency key, which a completion does not
  hold. A rename that crashed mid-flight and was finished by the sweep therefore leaves no
  audit pair. That is stated rather than papered over — an entry invented by a sweeper
  would claim a movement it cannot attribute.

### `SkuConflictError` outranks both stock refusals, and is checked for BACKING

The claim is written before the document that will hold the sku, so for one round trip
a live claim can exist that no committed row holds. Reporting "another live product
holds this sku" there would state something false about a peer holding nothing, so an
UNBACKED live claim falls through to the stock question and answers
`SkuStockConflictError` when the target already has an inventory document. A committed
claim is always backed, so the precedence the contract pins is untouched.

### Product-commerce crash seams proven

`test/product-commerce-crash-seams.dialects.test.ts` opens each window with the shared
fault injector, reads the documents back BEFORE replaying, and asserts conservation at
the seam as well as after it:

- **crash after the product write, before any stock moves** — the rename is committed
  and the carry recorded; the sweeper completes it, and a second run moves nothing.
- **crash after the source is zeroed and stamped** — the units are on neither count,
  and the stamped quantity is what keeps the sum invariant; the replay credits the
  target exactly once and clears the stamp.
- **crash after the target is credited** — the ring, not the caller, is what stops the
  replay crediting 50 units instead of 25; the completion only drops the stamp.
- **a second transfer of the same token** — a no-op, which is the case that would double
  the stock if the token were minted per attempt instead of derived from the command.
- **a hold landing between the decision and the stamp** — the rename commits, the source
  is never zeroed so no unit is lost, the sweep reports the carry as unfinished rather
  than pretending otherwise, and a new rename is refused typed until the hold clears.
- **two completions racing** — the target is credited exactly once.

### Contention, measured

The rename shapes are not hot-document shapes: the product document is contended only
by its own concurrent writers, and the carry's two inventory documents are contended by
a rename and whatever else touches those skus.

| shape | max CAS attempts |
|---|---|
| product sku renames, seed and restock races (`sku-rename-race.pg.test.ts`, 8 cases) | 4 |
| variant renames and the two cross-grain rules (`variant-sku-rename-race.pg.test.ts`, 11 cases) | 2 |

Both are reported per FILE by a final case that asserts them at or below
`CAS_MAX_ATTEMPTS` (24) and strictly above zero, so a shape that silently stopped
contending would fail rather than pass quietly.

## Coupon document model

`EmdashCouponStore` implements the whole `CouponStore` port. Four documents:

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `coupons` | coupon id | the economics, the window, `usesCount`, and a best-effort `lastRedeemedKey` witness | `createdAt` |
| `coupon_codes` | folded code | `{ code, couponId }` — the code-uniqueness claim, and the only way to reach a coupon by code | — |
| `coupon_redemptions` | `${couponId}:${idempotencyKey}` | the per-key claim carrying the full intent, the bump-right `state` and its lease, then the RECORDED outcome | `couponId`, `orderId`, `createdAt`, `redemptionId`, `holdsUse` |
| `coupon_customer_caps` | `${couponId}:${customerId}` | the keys currently holding a per-customer slot | — |

| The SQL | Here |
|---|---|
| `uses_count + 1 WHERE max_uses IS NULL OR uses_count < max_uses` | two client-side branches — a guarded `updateIf` when capped, a plain delta when not |
| `coupon_redemptions (coupon_id, idempotency_key)` UNIQUE | the document id, claimed create-if-absent |
| the insert conflict that made a second caller of one key WAIT for the winner | that document's own `state`: `claimed → bumping` is a revision compare-and-set exactly one completer wins, under a lease |
| a per-customer `COUNT(*)` taken under the coupon row's lock | the per-customer counter document, claimed BEFORE the bump |
| `ROLLBACK` undoing a per-customer refusal | an explicit, idempotent compensation |
| `uses_count - 1 WHERE uses_count > 0` | the mirror-image `updateIf` guard |
| `DELETE … WHERE NOT EXISTS (redemptions)` | a `count()` on the coupon's redemptions holding a use, read before the delete |

### The redemption state machine

The coupon is read first and nothing is written until it is found. Then:

1. **claim** `coupon_redemptions/{couponId}:{key}` create-if-absent, carrying the whole
   intent in state `claimed`. A claim that is already TERMINAL is the replay answer and
   no counter is touched — including for a REFUSAL.
2. **claim the per-customer slot**, when the customer is identified and a cap is in
   force: add this key to `coupon_customer_caps/…`. The cap is full ⇒ record
   `COUPON_MAX_PER_CUSTOMER`, having consumed no global headroom at all.
3. **take the bump right**: `claimed → bumping`, a compare-and-set on the key
   document's revision. Exactly one completer wins it, and only the winner reaches the
   counter. A caller that loses reads the winner's answer back.
4. **re-assert the right, then bump the counter.** A compare-and-set at the revision
   step 3 produced re-stamps the lease and proves the step is still ours; only then does
   the guarded statement run, and it guards the cap and nothing else.
5. **record** `applied` (or `refused`, after compensating) on the key document.

**Why step 3 exists, and why the guard carries nothing but the cap.** N callers
completing ONE idempotency key — which is what a retried checkout looks like — must add
exactly one use. Making the guarded statement itself once-only would mean pinning a
per-key witness into its `where`, which turns the delta into a revision compare-and-set:
every redemption then contends with every OTHER redemption of the same coupon, and the
retry depth grows with the CROWD rather than with the headroom (50 racers against the
24-attempt ceiling can exhaust it on a coupon with 95 uses left). Worse, it is not even
sufficient: a peer's bump overwrites the shared witness field, and a same-key replayer
that no longer sees its own key there bumps again. So once-only lives in the key
document, where it is per KEY and contends with nothing, and the counter's guard is the
invariant alone. Both halves are pinned by `coupon-no-over-redeem.pg.test.ts`: 20
completers of one key while 20 peer keys commit, capped and uncapped.

**The bump right is leased, because "slow" and "gone" look identical.** A step held by a
live owner and one held by a crashed owner are the same document, and a taker that
guesses wrong bumps twice. So `bumping` carries `bumpLeaseUntil` — `COUPON_BUMP_LEASE_MS`,
**10 seconds** by default, overridable per store with the `bumpLeaseMs` option — and a
waiter takes the step over only once that lapses. Until then it re-reads, and if it runs
out of patience it raises the typed retryable `StorageContentionError` so the caller's own
retry reads the recorded answer. That is the email-outbox lease (ADR-0019 R2) applied to
the same problem, and `coupon-crash-seams.dialects.test.ts` pins it from the forbidden
side: with the owner's `+1` PARKED, a second completer of the same key must refuse
retryably rather than add a use behind its back.

**What a crashed completer costs the next caller.** A waiter is bounded by the
compare-and-set budget — about a second — so it can never outlast a ten-second lease.
While the lease still stands, a call on that key is answered `STORAGE_CONTENTION`
(retryable, nothing written); past it, the next call takes the step over and completes it.
So a crash mid-bump makes ONE key unavailable for up to the lease, with a typed retryable
answer the whole time, and the coupon itself stays fully usable by every other key. A
deployment that would rather trade a shorter unavailable window for a higher chance of
overtaking a merely slow owner can lower `bumpLeaseMs`; the counter stays exact either
way, because the lease is not what protects it.

**The right is re-asserted, not merely taken — and that is what protects the counter.**
A lease cannot stop an owner from being descheduled past its own expiry, having its step
legitimately taken over and finished, and then waking up. So immediately before the
counter write, the owner compare-and-sets the key document at the revision it last held
(which doubles as renewing the lease). The taker's write moved that revision, so the woken
owner is refused, adds nothing, and reads the taker's recorded answer. The revision IS the
owner token: anything that writes the key document invalidates it, which is stronger than
any id the store could have minted. `a SLOW owner woken after a legitimate takeover is
fenced at its heartbeat` is that case, and a design that skipped the re-assertion fails it
at the first assertion, before the takeover even happens.

**Clock skew, and which side loses.** `bumpLeaseUntil` is stamped from the OWNER's clock
and compared against the READER's, so a reader running ahead by more than the remaining
lease will call a live owner gone and take the step over early. With the re-assertion in
front of every counter write that is a LATENCY fault rather than a correctness one: of two
callers that both believe they own the step, whichever writes the key document first
fences the other out at its next heartbeat, so the counter still moves exactly once. The
loser is a caller — refused retryably, or reading the winner's answer — never the data.

**The counter's attempt depth is 2, whatever the crowd.** A redemption's guarded `+1`
can be refused for exactly one reason — the coupon reached its cap — and the next read
settles that, so the step never retries more than once (plus one per concurrent RELEASE
that hands headroom back mid-flight). Capped redemptions of one coupon are therefore NOT
serialized against each other: nothing is pinned but the invariant, so nothing contends
until the invariant actually binds.

### Coupon crash seams proven

`test/coupon-crash-seams.dialects.test.ts`, with the shared fault injector:

- **a PARKED guarded update** — the claim has landed and the counter has NOT moved. This
  is also the proof that the helper really intercepts `updateIf`; without it every seam
  below could pass while injecting nothing.
- **a LIVE owner is never overtaken** — the peer of a parked owner refuses retryably, and
  the counter does not move behind the owner's back.
- **after the key-doc create, before the slot claim** — the replay takes the slot once
  and bumps once; the record was still `claimed`, which provably owns nothing.
- **after the per-customer slot, before the `+1`** — the replay completes the bump and
  takes no second slot: counters exact.
- **after the `+1`, before the recorded answer** — the witness survives, so the taker
  recognises the bump and does not repeat it: counters exact.
- **the same, with a PEER bump overwriting the witness** — the documented residual,
  asserted rather than argued: two redemptions, three uses. ONE HIGH, never low.
- **a refused `+1`** — the slot is given back and the refusal recorded, so a per-customer
  rejection consumes no global headroom and a global refusal leaves no slot consumed.
- **after the refusal, BEFORE its compensation** — the replay re-runs both, and the slot
  still comes back.
- **after the compensation, before the recorded answer** — the replay refuses again and
  releases nothing twice.
- **two CONCURRENT replayers of a refused key** — one answer, one compensation. The loser
  can take its slot AFTER the winner has compensated, which is why the compensation is
  re-asserted by every caller that is told `COUPON_EXHAUSTED` rather than only by the one
  that ran the refusal.
- **a SLOW owner woken after a legitimate takeover** — the lease lapses while the owner
  is parked, a taker completes the redemption, and the woken owner is fenced at its
  heartbeat: one use, one `applied` answer, and the owner returns the taker's redemption
  id. The case also pins the ORDER — with the park held, the counter has not moved.
- **between a release's slot-free and its delete** — the replay deletes and decrements
  exactly once.
- **between a release's delete and its decrement** — the second accepted residual,
  asserted rather than papered over: the counter is left one HIGH, never low, and a second
  release is a no-op rather than a second decrement. A release claims its decrement by
  DELETING the record, which is what makes a double release impossible; the price is that
  a crash in between leaves one use nobody holds.

**The residuals are all the same residual, in the same direction.** A guarded delta in one
document cannot be made idempotent by anything written in another, so every place where a
crash can fall between the counter and its record leaves the count at most ONE HIGH per
crash. High refuses a redemption that might have fit; it never grants one that does not.
Nothing here can leave it low, which is the direction that would over-redeem. There are
three such places, and the third is worth stating precisely because it is the one the
heartbeat does NOT close:

1. a crash after the `+1` and before the recorded answer, where a peer has overwritten the
   witness — the taker re-bumps;
2. a crash between a release's delete and its decrement — the use stays counted;
3. a pause of more than a FULL LEASE between the heartbeat and the `updateIf` it fences.
   The two are adjacent storage calls, so reaching this means being descheduled for ten
   seconds between consecutive statements — an order of magnitude longer than the entire
   call is allowed to take, since the whole retry budget is 24 sleeps of at most 50 ms.
   Closing it would need the two writes to be one, which is the atomicity this store does
   not have; a shorter `bumpLeaseMs` widens it and a longer one narrows it.

Making (1) or (2) exact needs a recount of the coupon's redemption documents — a sweeper
job, and not this store's to do on a request path.

### Four deviations from the design's index table, all forced

ADR-0019 §4 lists `coupons` keyed by **code** with a `createdAt` index, and
`coupon_redemptions` indexed on `couponId` and `orderId`. What shipped:

| Change | Why |
|---|---|
| `coupons` is keyed by **coupon id**, and the code becomes a claim document | `redeem`, `findById`, `update` and `delete` are all given an id, and the money path must not pay a lookup to reach the counter. The admin list is keyset-ordered on `(createdAt, id)` — which is the host's own total order only when the document id IS that id. The ADR's own `uniqueIndexes` table offers exactly this alternative for `coupons.code`: "the document id, or a claim document". The coupon's index list is unchanged at `createdAt` alone as a result, and the code search needs no index because it is a document read |
| `coupon_redemptions` adds `createdAt` | `listRedemptionsCreatedBefore` both RANGES and ORDERS on it, and ordering by an undeclared field throws exactly as filtering on one does |
| `coupon_redemptions` adds `redemptionId` | `release` is given the GENERATED id, not the document id — the port hands back an opaque id exactly as the SQL adapter did |
| `coupon_redemptions` adds `holdsUse` | a refused key keeps a document (that is what lets a replay answer the same way twice), and it must stay out of the delete guard, `releaseByOrder` and the reconciliation sweep. A boolean cannot be bound as a filter value on one dialect, so it is a STRING mirror — the same pattern as the product gate's `publishKey`, not a second invention |

The redemption's `state` and its lease are NOT indexed: nothing queries by them, and
every reader that needs them already has the document.

### Two accepted divergences from the SQL adapter

Both are narrowings, both are documented rather than discovered:

- **A refusal is recorded permanently**, so a replay of an exhausted key answers
  `COUPON_EXHAUSTED` again even if headroom has since been released. The SQL adapter
  rolled its refusal back and kept no record, so a retry there could later succeed. A
  stable answer per idempotency key is the property the document model is built on. A
  refused record is also never removed by `delete` — it holds no use, so it never forbids
  one; it stays because it is that answer, and because document ids are not reused.
- **Codes are unique after case folding**, where the SQL unique index was
  case-sensitive. That is the rule the admin list's case-insensitive exact search already
  implies. `findByCode` stays case-SENSITIVE, by comparing the code the claim stores.

A per-customer counter document exists only while `maxUsesPerCustomer` is in force, so
RAISING a cap from null counts only the redemptions made while a cap was set; the SQL
counted rows, which had no such window. Bounded arrays were preferred to a faithful
unbounded one here, and the alternative is a per-customer index on the redemptions.

### Coupon contention, measured

`test/coupon-no-over-redeem.pg.test.ts` measures the counter step (`redeem`) separately
from the bounded wait a caller spends reading a peer's answer (`redeemAwait`), because
they are different costs: one is a WRITE contending for an invariant, the other is reads.

| shape | counter depth | wait depth |
|---|---|---|
| 50 racers on a 5-use cap (20 loops) | 2 | 1 |
| two same-customer racers on a per-customer cap of 1 (15 loops) | 2 | 1 |
| 20 racers completing ONE idempotency key | 1 | 4 |
| 20 completers of one key WHILE 20 peer keys commit, capped and uncapped | 1 | — |
| 40 racers on an UNCAPPED coupon | 1 | 1 |
| 50 racers on a coupon with 95 uses left | 1 | 1 |

The counter step is asserted at `<= 2` — a hard bound, not a measurement — and the
overall depth against a hand-set `CAS_ATTEMPT_BUDGET` of 8, deliberately tighter than
`CAS_MAX_ATTEMPTS`, so raising the package ceiling can never turn a shape green by
accident. The last row is the one that says the depth follows the headroom and not the
crowd: 50 racers, a 24-attempt ceiling, and nobody retries at all.

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
| 40 concurrent challenge requests at a per-address cap of 3 (15 loops) | 4 | 0 |
| two concurrent crowds of 20 on two addresses, cap 3 each | 3 | 0 |
| a consume freeing one slot against a crowd of 20 (10 loops) | 2 | 0 |
| 30 concurrent registrations of one address (15 loops) | 1 | 0 |
| 12 concurrent redeems of one address, get-or-create (8 loops) | 8 | 0 |
| 24 concurrent grants of one entitlement key (12 loops) | 2 | 0 |
| 16 concurrent grants for one scope, distinct keys (10 loops) | 2 | 0 |
| 16 concurrent settings updates on one key (10 loops) | 3 | 0 |
| 10 concurrent settings updates, field-disjoint patches (8 loops) | 7 | 0 |

The last four rows are the entitlement and settings races
(`entitlement-grant-race.pg.test.ts`, `settings-mutation-race.pg.test.ts`), and they split
the way every claim in this package does. The two grant shapes are **document-bound**: a
grant key and a scope pointer are each taken once by a create-if-absent, so a peer is
refused without contending again and the depth is the read-back, never the crowd. The two
settings shapes are not. The same-key stampede measures 3 because a caller can lose the
settings write to a peer applying the identical value and then lose the result stamp to
whoever recorded it first; the field-disjoint crowd measures 7 and is **crowd-bound**,
because distinct-key updates are last-writer-wins by port contract, so nothing refuses
anybody and a writer can lose its revision once per peer that commits ahead of it. That is
the shipping/tax rules shape, which is why the settings budget is asserted at
`CAS_MAX_ATTEMPTS` rather than under it.

The identity races (`login-challenge-race.pg.test.ts`,
`customer-email-claim-race.pg.test.ts`) are worth reading as a pair. The
registration stampede measures **1**: the first writer takes the claim and every peer is
then refused by reading it, so nothing contends. The get-or-create measures **8**, and
that depth is not contention at all — it is the bounded WAIT a redeemer spends re-reading
until the winner's account document is readable, because the claim refuses a second
registration from the moment it is taken, which is a moment before the account behind it
exists. It is measured at N=12 and grows with how long the winner takes, not with the
crowd.

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

## Shipping and tax rules document model

`EmdashShippingRulesStore` and `EmdashTaxRulesStore` implement the whole
`ShippingRulesStore` and `TaxRulesStore` ports. Two aggregates, two claims:

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `shipping_zones` | zone id | the zone's name and opaque region list, its `methods` map keyed by method id, and each method's `rates` map keyed by currency | — |
| `shipping_method_owners` | method id | `{ zoneId }` — the store-wide method-id claim, and the FAST way to reach a method from an id alone (the heal scan below is the fallback) | — |
| `tax_classes` | class id | the registry `name` (`null` when only rates live there) and the class's `rates` map keyed by rate id | — |
| `tax_rate_owners` | rate id | `{ taxClassId }` — the store-wide rate-id claim, and the FAST way to reach a rate from an id alone (the heal scan below is the fallback) | — |

| The SQL | Here |
|---|---|
| `shipping_methods.zone_id` / `shipping_rates.method_id` foreign keys | the child IS part of the parent document, so a child with no parent is unrepresentable; a create naming a missing parent throws where the insert was refused |
| `DELETE … WHERE NOT EXISTS (children)`, twice for shipping and once for tax | the same emptiness test, read from the document the delete is guarded on and committed with `compareAndDelete` at that revision |
| `shipping_methods.id` / `tax_rates.id` PRIMARY KEY | the two claim documents, created if absent |
| `shipping_rates` PRIMARY KEY `(method_id, currency)` | the method's `rates` map key — uniqueness inside one document is structural |
| `UPDATE … WHERE amount_cents = :expected` / `WHERE rate_bps = :expected` | the same expected-value comparison inside the aggregate's compare-and-set, re-evaluated on every attempt |
| `ORDER BY id` on all four list reads | sorted in code after an unfiltered paged scan, because ordering needs a declared index and neither collection declares one |

### Why two claim collections, where the design table names none

**Nine** port methods take a child id with **no parent**: `getMethod`,
`updateMethod`, `deleteMethod`, `createRate`, `getRate`, `updateRate` and
`deleteRate` on the shipping side (the last four keyed by `methodId`), plus tax's
`updateRate` and `deleteRate` keyed by rate id. With the
children embedded there is no document to read for those, and a scan would answer
ambiguously the moment one child id could sit in two parents — which SQL made
impossible with a primary key and which **no declared index enforces here** (see
"Known gap: no physical indexes" above). One document answers both halves:
create-if-absent on its id IS the uniqueness enforcement, and the parent id it
carries IS the reverse lookup. It is the `reservation_index` device, for the
reason ADR-0019 gives for that one.

An **orphaned** claim — one whose parent does not hold the child — is the crash
state, and the rule is that it misleads no reader and strands no id: every
id-taking method answers exactly as it would for an id that was never created, and
the next create of that id takes the claim over. A claim whose child really is
embedded is a collision and is loud.

### A tax rate may exist without its class

`tax_rates` had **no** foreign key to `tax_classes`, and the contract relies on it:
rates are created for classes nobody declared, `countRatesByClass` counts them, and
`getRate`/`listRatesForZone` return them. So `tax_classes/{classId}` is the document
that holds a class's RATES, and its `name` says whether the class was ever declared.
`null` is the undeclared case — skipped by `listClasses`, `not_found` for
`updateClass` and `deleteClass` (exactly what the missing row produced), adopted
rather than collided with by a later `createClass`, and deleted along with its last
rate so an undeclared class leaves no litter.

### The money CAS, and the retry that must re-verify

Both `updateRate`s guard a VALUE (`expectedAmountCents`, `expectedRateBps`), not a
version — the ABA acceptance both ports document. The value lives in a document that
also holds the parent's name and its other children, so unrelated writes contend for
one revision, and a lost revision race is retried by **re-reading and re-comparing**,
never by re-submitting the decision. A caller that lost a real edit race is therefore
told `stale` on its next attempt instead of overwriting the change it should have
seen — a wrong shipping fee or tax rate is money.

That is pinned from both sides: `test/rules-crash-seams.dialects.test.ts` parks the
losing write while a peer commits the change, deterministically and on every dialect;
`test/rules-cas-race.pg.test.ts` drives it with a crowd, including a case whose
contending peers are renames that touch no money at all, so the retry budget is
really spent and the guard still admits exactly one editor.

| shape (`rules-cas-race.pg.test.ts`, N=24, 12 loops) | max CAS attempts |
|---|---|
| tax `updateRate`, one rate, one expected value | 2 |
| shipping `updateRate`, one rate, one expected value | 2 |
| tax `updateRate` racing a storm of same-document renames | 6 (12 for the renames themselves) |

The first two sit at 2 for the reason the guard exists: a loser's second attempt
re-reads a value that has moved and stops, so depth does not grow with the crowd.

**The exception to "depth is a property of the document, not the crowd".** The three
structural edits — `updateZone`, `updateMethod`, `updateClass` — are LAST-WRITER-WINS
by port contract: they have no guard to refuse them, so every one of N writers of the
same document eventually commits, and a writer can lose its revision once per peer
that commits ahead of it. Their worst-case depth is therefore the CROWD SIZE, not a
property of the document: measured 12 at N=24 above, and past roughly N > 40 on one
document the budget runs out and the caller gets `StorageContentionError` — nothing
written, safe to retry. That is the documented shape of a rename storm on one zone or
class, not a money path: no invariant is at risk either way, and every money edit on
the same document still refuses cleanly as `stale`.

### Rules crash seams proven

`test/rules-crash-seams.dialects.test.ts`, over the one multi-document step each
store has:

- **the id was claimed, the parent embed never ran** — the orphan misleads no
  reader (`getMethod`/`getRate` null, the edits and deletes `not_found`, the parent
  still childless and still deletable), and the replay completes it exactly once.
- **an orphaned claim is taken over** by a create in another parent, while a LIVE
  child's id is never taken over — that collision is loud.
- **the child was removed, its claim was never released** — same orphan, same
  answers, and the id is reusable.
- **claim-before-embed, the forbidden order** — pinned from the other side by
  parking the embed: while it is parked the claim is already there and the child is
  not yet readable. A store that embedded first would pass every replay case above
  and fail here.
- **a money edit that loses its revision** re-reads and is refused as `stale`,
  carrying the peer's value.
- **a parent delete racing a child create** refuses with the referential reason
  rather than orphaning the child.
- **a release cannot take a claim a peer has adopted**: the deleter is held between
  its claim read and its `compareAndDelete`, the peer adopts the id for another
  parent and embeds it, and the release then refuses — the peer's claim survives and
  the child is reachable by id.
- **a peer whose embed lands AFTER a release** still ends up reachable, editable and
  in exactly ONE parent, and its id is refused to a second home. This is the
  interleaving below.
- **a child embedded with NO claim** — the residue, constructed directly — is
  rediscovered, re-claimed, and editable and deletable again.
- **`createRate` refuses a second rate for one `(method, currency)`**, the SQL
  primary key's refusal, leaving the quoted price untouched.
- **a claim naming the WRONG parent is re-pointed** at the parent that really holds
  the child, by the same id-keyed lookup — the heal's second branch, and the one that
  keeps a partially applied takeover from making a live child unreachable.

### The one residue, and why it is healed rather than prevented

The create's re-assertion closes every interleaving in which a release could take a
LIVE child's claim away, bar one: a peer adopting the orphan **for the same parent**,
with the deleter's claim read landing after the peer's re-assertion and its
`compareAndDelete` landing before the peer's embed. The deleter's parent check then
sees no child (it is not embedded yet) and its revision is current, so the release
lands and the child arrives a moment later with no claim. The same state is reachable
by a crash between an embed and the next re-assertion.

Preventing it would need a post-embed compensation — undo the embed when a
re-assertion fails — which has a crash window of its own and would leave exactly the
same residue. So it is **healed instead**: `getMethod` and the rate methods fall back
to a bounded scan when the claim does not resolve and re-establish the claim, and the
create path's collision test runs through that same lookup, so the residue can never
become one id in two parents either. The heal is automatic, not operator work, and
both halves are pinned by the two seam cases above.

**What the fallback costs, exactly.** The scan is a paged read of the parent collection
— 100 documents a page, up to `maxListPages` (1000), with the ceiling raised as a typed
`ScanPageLimitError` rather than a short answer.

| Call | Extra reads |
|---|---|
| any id-keyed read or write whose claim RESOLVES (`getMethod`, `getRate`, `updateRate`, `deleteRate`, `updateMethod`, `deleteMethod`) | **none** — the claim is still the fast path |
| `listZones`, `listMethods`, `listClasses`, `getRate(class, zone)`, `countRatesByClass`, `listRatesForZone` | **none** — none of them consults a claim, so the **checkout read never heals** |
| `createMethod` / `createRate` with a fresh id | one full parent scan **per compare-and-set attempt** of the claim step, because the collision test runs through the healing lookup |
| an id-keyed read or write for an id that does not exist (`getMethod("missing")`, a `not_found` update or delete) | one full parent scan per attempt, before answering `null` / `not_found` |
| an id-keyed call whose claim is missing or points at the wrong parent | one full parent scan, plus the one claim write that re-establishes it |

Both stores are admin-surface stores over collections sized by the merchant's zone and
tax-class count, and the checkout reads are in the first two rows, which is what makes
that trade the right way round.

## Identity document model

`EmdashCustomerStore`, `EmdashAddressStore`, `EmdashSessionStore` and
`EmdashCredentialVerifier` implement the whole `CustomerStore`, `AddressStore`,
`SessionStore` and `CustomerCredentialVerifier` ports. One aggregate, two claims,
two ledgers:

| Collection | Doc id | Holds | Declared indexes |
|---|---|---|---|
| `customers` | customer id | the account fields and the embedded `addresses` list | `emailLower` |
| `customer_emails` | folded email | `{ customerId, claimedAt }` — the address-uniqueness claim, and the FAST way from an address to its account (the indexed query below is the fallback) | `emailLower` (unique) |
| `sessions` | token **hash** | `{ sessionId, customerId, createdAt, expiresAt, revokedAt }` | `customerId` |
| `login_challenges` | challenge id | `{ emailLower, tokenHash, expiresAt, consumedAt }` plus the `consumed` text mirror | `consumed`, `expiresAt` |
| `login_challenge_claims` | folded email | the slots currently holding the per-address window | — |

| The SQL | Here |
|---|---|
| `customers.email` NOT NULL UNIQUE | the `customer_emails` claim, created if absent, taken **before** any customer write and re-asserted immediately before it |
| `addresses.customer_id` with no foreign key | the addresses are embedded, and a `null` email is the "no account here" case the missing row produced |
| `UPDATE/DELETE addresses WHERE id = :addressId AND customer_id = :customerId` | an explicit ownership check inside the caller's own document, taken on the read the write is guarded on |
| `ORDER BY created_at, id` on the address book | sorted in code; the list is inside one document, so there is nothing to page |
| `customer_sessions.token_hash` UNIQUE | the hash **is** the document id |
| `WHERE token_hash = :hash AND revoked_at IS NULL AND expires_at > :now` | one document read, then two field reads on it |
| `SET revoked_at = :now WHERE revoked_at IS NULL` | a compare-and-set guarded on the revision of a document whose `revokedAt` was still absent |
| `ORDER BY created_at DESC, id DESC` on the session history | sorted in code after a bounded paged read on the `customerId` index |
| `SET consumed_at = :now WHERE id = :id AND consumed_at IS NULL` | the same, on the challenge document; a lost race re-reads and answers `CONSUMED` |
| `DELETE … WHERE consumed_at IS NOT NULL OR expires_at <= :now` | two bounded arms, because the filter algebra has no OR; the deletes deduplicate the overlap |
| `SELECT count(*) … WHERE email = ? AND consumed_at IS NULL AND expires_at > :now`, **then** `INSERT` | the `login_challenge_claims` document: the count and the admission are one compare-and-set |

### The throttle was a race, and it is retired by construction

The SQL counted a per-address window and then inserted, in two statements, with no
transaction and **no unique constraint on `login_challenges` at all**. Two requests
that both read a count below the cap both insert, so the cap could be exceeded by as
many callers as arrive together. ADR-0019 §7.17 names that and refuses to let it be
inherited silently.

The window is a claim document instead, and the state machine is small:

```
admit    : read the claim → drop lapsed slots → refuse if the rest fill the cap
           → compare-and-set the value it counted, with this slot added
write    : create-if-absent the challenge the slot names
consume  : compare-and-set the challenge (revision + consumedAt absent)
release  : remove this slot at the revision read AFTER the consume committed,
           deleting the document when it empties
```

Of N concurrent admissions exactly one wins each revision, so the cap is **exact**,
not approximate — 40 concurrent requests at a cap of 3 admit 3, and a freed slot is
worth exactly one more admission and never two (`login-challenge-race.pg.test.ts`,
measured depth 4). A refusal writes nothing at all: the response is identical to the
success case either way, which is the port's own rule about throttling not becoming an
enumeration oracle.

Every residual points the same way, which is the direction ADR-0019's rule (c)
requires:

| Crash | Residue | Cost | Heals by |
|---|---|---|---|
| after the admission, before the challenge write | a slot naming a challenge nobody can redeem | one admission refused | the slot's own expiry |
| after the consume, before the release | a slot for a spent challenge | one admission refused | the slot's own expiry |
| the compensating release itself is lost | as above | one admission refused | the slot's own expiry |

No sweeper is required, because every slot carries the expiry of the challenge it
names and the next admission drops it. That is also the one place the window is
pruned: a refusal does not write.

**Two deliberate swallows, and only two.** `releaseChallengeSlot` and the email claim's
compensating release (`createCustomer.release`) do not propagate
`StorageContentionError`. It runs only after the write it compensates for has already
been decided, so raising would turn a login that has already succeeded into an error
the user cannot retry — the challenge is spent, so the replay answers `CONSUMED` — in
exchange for freeing a slot a moment earlier. Not raising leaves an over-refusal that
expires by itself. The email release is the same trade on the same shape: it runs inside
`create`'s catch, on a path that is already failing, and raising there would REPLACE the
failure the caller has to see with one about the compensation — while an unreleased claim
is just an orphan the abandon window heals. Every other contention failure in this
package propagates.

### The email claim needs an abandon window, and the race proved it

The claim is taken before the account document is written and re-asserted immediately
before that write (rule (a)). That is not sufficient on its own: a peer that read the
claim between the re-assertion and the account write saw a claim with no account
behind it, called it orphaned, took it over — and both callers then wrote an account
under one address. The first run of `customer-email-claim-race.pg.test.ts` found
exactly that.

So the claim carries `claimedAt` and a `CLAIM_ABANDON_AFTER_MS` window (60 s, option
`claimAbandonAfterMs`), for the reason the sku claim carries one: **a holder a moment
from writing and a holder that is gone are the same document.** A claim no account
holds is taken over only once it is older than the window; until then the address is
refused as a duplicate — which is what it is about to become, and which for a genuinely
crashed holder is an over-refusal bounded by one window rather than a duplicate account
that is forever.

**The re-assertion is a heartbeat, so the lease renews.** Every attempt stamps a fresh
`claimedAt` alongside the revision it re-asserts, exactly as the sku claim and the coupon
bump right do. A registrant that is slow but alive — retrying inside the compare-and-set
budget — therefore keeps its lease however long the retries take, and only one that
stopped writing lets the window lapse. A fixed deadline stamped at the first claim would
have made the window a timeout on the whole call instead.

**The fence, and what clock skew costs.** Renewal is half of it; the other half is that a
holder which DID lapse must not commit the work it no longer has the right to do. That is
the re-assertion's other job: it is pinned to the revision the takeover replaced, so a
registrant parked past its window wakes to a refused re-assertion and returns
`DuplicateCustomerEmailError` with no account written — pinned by "a registrant parked
past the abandon window is fenced out by its own re-assertion", on all three tiers, and
that case fails if the refusal is removed. The window is stamped from the holder's clock
and read against the taker's, so a reader a full window ahead can call a live claim
abandoned and take it over: the holder's next re-assertion then refuses, which is the
fence working rather than failing. Skew costs a spurious refusal for the slow or skewed
registrant, never a second account, and no invariant depends on the two clocks agreeing.

One caller feels that refusal legitimately: the verifier's get-or-create behind a
redeem. The claim refuses a second registration from the moment it is taken, which is
a moment before the account behind it is readable, so a single re-read after the
duplicate could find nothing and report a duplicate for an address the caller was
logging into. Its re-read is therefore **inside** the bounded retry, and only an
exhausted budget is reported — as the typed retryable contention failure, never as a
duplicate (measured depth 8 at N=12, which is the wait, not contention).

### The claim is the fast path; the email lookup heals

`getByEmail` follows the claim, and when it does not resolve it queries the declared
`emailLower` index, takes the lowest customer id deterministically, and re-establishes
the claim. So the read **may write**, and it may raise `ScanPageLimitError` where the
SQL could only answer `null` — both the price of never leaving a registered account
unreachable by its own address. The cost is asymmetric on purpose:

| Call | Extra reads |
|---|---|
| `getByEmail` whose claim RESOLVES | **none** — one claim read plus the document |
| `get`, `update`, and every address and session method | **none** — none of them consults a claim |
| `create` | one lookup per compare-and-set attempt of the claim step, because the collision test runs through the healing lookup |
| `getByEmail` for an address nobody holds | one bounded indexed query, before answering `null` |
| `getByEmail` whose claim is missing or stale | one bounded indexed query, plus the one claim write that re-establishes it |

### A customer document can exist without a customer

`addresses` had no foreign key to `customers`, and the address-book contract relies on
it: a book is written for a customer id nobody registered. So `email` is what says
whether an account was ever created. `null` is the undeclared case — `get`,
`getByEmail` and `update` answer for it exactly as the missing row did, a later
`create` for that id **adopts** it rather than colliding (its addresses are that
customer's), and it is deleted along with its last address so an address-only document
leaves no litter. It is the device the tax store uses for a rate whose class nobody
declared, and for the same reason.

### Nothing stores a token

`create` mints an opaque session token, returns it once and persists only its SHA-256.
The challenge stores only the hash of the token it emailed. Both hashes come from
WebCrypto off `globalThis` — never `node:crypto`, which does not exist in the sandbox —
and the challenge's comparison is a hand-written constant-time one, because
`timingSafeEqual` does not exist there either. A session is reachable by exactly two
routes: the hash of a token somebody holds, or the `customerId` index the port's own
history read requires. `SessionSummary` carries a separate `sessionId`, so no
credential material has a path onto an admin surface even by accident.

### Identity crash seams proven

`test/identity-crash-seams.dialects.test.ts`, both Node dialects, each reading the
residue back before proving what a later caller sees:

| Seam | Residue | What a later caller gets |
|---|---|---|
| claim taken, account write lost | none — the compensating release gives the address back | the address registers cleanly |
| claim taken, account write **and** release lost | an orphan claim | refused for one abandon window, then taken over; no account is ever visible under the address meanwhile |
| an account whose claim was deleted | none, after the next lookup | the account is found by address and the claim is written back |
| slot taken, challenge write lost | none — the slot goes back | the full window is admittable |
| slot taken, challenge write **and** release lost | a held slot | one admission fewer until the slot's expiry |
| consume committed, release lost | a held slot for a spent challenge | the replay is `CONSUMED`; the window resets at the expiry |
| an address update that loses its revision to a concurrent delete | none | the retry re-checks ownership and answers the miss rather than resurrecting the address |
| a registrant parked past its lease, overtaken by a peer | none | its own re-assertion refuses before any account write: one account owns the address, and it is the peer's |
| consume committed and slot released, then `#resolveCustomer` exhausts its budget | a spent challenge with no account resolved | the caller sees the typed retryable failure and the link cannot be replayed (`CONSUMED`) — one lost login, never a second redemption. Not enumerated in the suite: it needs a contention storm on a document only one caller writes |

### What the identity tier does NOT carry

- **No email change and no customer delete.** `UpdateCustomerInput` patches
  `displayName` and `emailVerifiedAt` only, and there is no delete on either port. So
  the release ordering has exactly one site — the compensating release when an account
  write did not land — and the "un-embed, then release at a post-write revision" rule
  has nothing else to guard here.
- **No sweeper.** Both claims heal in path: the email claim by the lookup's fallback,
  the throttle by the expiry every slot carries.

## Entitlement, payment-event, settings and order-note document models

The four smallest ports in the commerce layer, and the only tier where two of the four
stores write exactly one document per call. Seven collections:

| Collection | Doc id | What it is |
|---|---|---|
| `entitlements` | grant idempotency key | one grant; the key IS the once-only |
| `entitlement_lookups` | `order:{orderId}:{sku}` / `buyer:{foldedRef}:{sku}` | a pointer from one authorization scope to the grant that satisfies it |
| `payment_events` | dedupe key | the received-events audit row |
| `payment_anomalies` | a digest of the anomaly's own fields | one alert-worthy settlement anomaly |
| `settings` | `store` | the operational settings singleton |
| `settings_mutations` | mutation idempotency key | one mutation's intent, and — once — its result |
| `order_notes` | note idempotency key | one append-only merchant annotation |

Declared indexes: `entitlements` declares `orderId`, `buyerRefLower`, `sku` and `state`;
`order_notes` declares `orderId`; the other four declare nothing, because nothing
queries them.

### The delivery gate, and why its pointer is a cache

`check` is the file-serving gate: no active grant, no download. The SQL served it with
two composite indices — `(order_id, sku, state)` and `(lower(buyer_ref), sku, state)` —
behind the predicate
`state = 'active' AND sku = ? AND (order_id = ?)? AND (lower(buyer_ref) = ?)?`. Here the
filter algebra is AND-only over single declared fields, so the composite becomes a
conjunction of four declarations, and `state` is declared rather than filtered in code
for a specific reason: a page of revoked grants must not be able to hide an active one
behind the limit.

That query alone is correct and indexed. The `entitlement_lookups` pointer sits in front
of it so the hot single-scope path pays two keyed reads instead of an index scan — and it
is therefore a **cache, never authority** (ADR-0019 rule (b)). Three consequences, all
deliberate:

- A pointer is re-validated against the grant it names. A pointer whose grant is
  revoked, missing, or disagrees about the scope or the sku authorizes nothing.
- When a pointer does not resolve, the gate queries and writes the pointer back, so
  `check` is a read that may WRITE. That is the one mechanism healing both a crash
  between the grant and its pointers and a pointer left on a revoked grant. Its cost is
  one indexed page of one row, on the reads that miss only.
- **Revocation needs no pointer maintenance**, which is why the store has no revoke
  method to keep in step with one.

The operator-authenticated shape — an order id AND a buyer reference — has no pointer of
its own and goes straight to the query. A third key space for a conjunction no hot path
takes would be cost without a read to serve.

**What a stale pointer costs, exactly.** A scope whose named grant has been revoked and
then re-granted under a new key pays, per `check`, until the first one heals it: the
pointer read, the named grant's read, and one indexed query of one row — three reads
rather than two, plus one pointer write on the read that heals. `#claimLookup` on the new
grant does NOT displace the stale pointer (an existing pointer is left alone, which is
what makes one scope's pointer deterministic under concurrent grants), so the re-grant
itself does not clear it; the next `check` does. That is the asymmetry rule (b) describes:
a scope whose pointer resolves pays nothing extra, and the one that does not pays a
bounded, self-clearing surcharge.

### The scope id is an authorization key, so its parts are escaped

A scope is a pair, and joining two arbitrary strings with a separator is ambiguous:
`("ord-a", "B:C")` and `("ord-a:B", "C")` collide under a raw join, and one document
authorizing the other's delivery is a security bug rather than a collision statistic.
Both value parts are percent-escaped before they are joined — `%` first, so escaping the
escape cannot collapse two encodings onto one — and a case drives the collision end to
end.

### A scopeless check is refused, not answered `false`

The SQL short-circuited a query with neither scope to `false`; so did the in-memory fake.
Here it raises `EntitlementScopeRequiredError`, and that is a deliberate divergence in
loudness (never in outcome — both are fail-closed, and nothing is served either way). The
port's type requires a sku and makes both scopes optional, so a scopeless query is not a
condition a storefront produces: it is a caller that lost its session or its order id
somewhere above and is about to serve a file on the strength of a sku alone. `false`
hides that as a refused download; the typed error names it.

### Payment events: two collections, because a document id cannot be null

The SQL kept deliveries and anomalies in one table separated by a nullable UNIQUE column
— a delivery row carried a `dedupe_key`, an anomaly row carried a `kind` and a NULL key,
and the nullable UNIQUE is what let many anomalies coexist while a real dedupe key
collided. A document id cannot be null, so the two shapes become two collections, which
states the separation in the schema rather than in a convention about which columns are
set.

Two divergences worth naming:

- **A dedupe key redelivered against a DIFFERENT order still answers `false`.** Faithful:
  the SQL's UNIQUE was global and its conflict clause silent. The loud cross-order guard
  is the order store's `payment_refs/{providerRef}` claim, because that is the write that
  moves the captured total and therefore the refund ceiling. This store holds no order
  pointer of its own and deliberately duplicates none.
- **`recordAnomaly` is genuinely idempotent, where the SQL was not.** The document id is
  a SHA-256 of the anomaly's five fields, so a replay producing the identical anomaly
  records it once; the SQL minted a fresh row id per call and wrote a second
  indistinguishable row. Anything that differs — including the instant — is its own
  document, and nothing is ever swallowed.

**`payment_anomalies` is write-only and unindexed, so it grows without a reader or a
prune** — an operator surface that lists and retires anomalies is owed, and it is what
will decide the collection's indexes.

### Settings: the claim carries the intent and the revision it was decided against

The SQL did the whole of `update` inside one transaction: read current, merge, claim the
key with the merged values, and — as the claim's winner only — upsert the row. Without a
transaction the steps become:

```
claim  : settings_mutations/{key} create-if-absent, carrying the PATCH and the settings
         revision the creator just read — both written once, never rewritten
apply  : merge the patch over the current settings, compare-and-set — the CREATOR at the
         revision it just read, anyone else at `decidedRevision` or not at all
record : the claim's `result`, assigned EXACTLY ONCE, after that write committed
```

**The claim cannot carry a pre-computed result.** The SQL's ledger row could store the
merged values at claim time because the claim and the upsert were one transaction, so
"claimed" and "applied" were the same instant. Split across two documents they are not,
and a result recorded before the write is PROVISIONAL: if a peer moves the settings the
mutation has to be re-decided against a newer base, and anything that read the
provisional value holds an answer no state ever had — including a concurrent caller of
the same key, which is how two callers of one key end up disagreeing.

So the two halves are explicit. A claim with `result: null` means DECIDED; a claim with a
result means LANDED, and that result is single-assignment — written after the settings
write, guarded on the claim revision that still had `result: null`. Of any number of
callers of one key, the first to record decides the answer and every other one reads it.

**And a DECIDED claim is pinned to the revision it was decided against**, which is what
makes the crash case safe rather than merely completable. Four consequences:

- **A replay of a landed mutation writes nothing**, so a stale replay arriving after a
  newer update returns what its mutation applied and cannot clobber the newer value. The
  document-model suite pins that on the two documents' revisions rather than on their
  values.
- **A caller that did NOT create the claim may apply it only at `decidedRevision`.** Past
  that revision the patch was computed against a state that no longer exists, so applying
  it would overwrite whatever replaced that state — the clobber the port forbids. It is
  refused instead, with a non-retryable `SettingsMutationSupersededError` carrying the key
  and both revisions, and nothing is written. The remedy is a fresh idempotency key, which
  is a new decision against the current state. Merging cannot revert a field the patch
  OMITS, because an omitted field is read from the base — but it says nothing at all about
  the fields the patch NAMES, which is exactly what the pin is for.
- **A non-creator completion can therefore succeed at most once, ever**, because applying
  it moves the revision it was pinned to. The patch can never be applied twice.
- **The creator keeps re-merging over the new base**, because its intent is live — it is
  the call the operator is waiting on, not a replay of a decision made earlier. That is
  why distinct-key updates never lose each other's fields, which the race drives with
  field-disjoint patches, where a lost update would be visible as a field reverting to its
  domain default.

**A merge that changes nothing writes nothing.** If the patch's effect is already present
in the document that was read, the mutation is recorded against the value that is there
and no settings write is issued. It cannot mask a clobber — a no-op write clobbers nothing
— and it does two useful things. It lets a mutation whose own write landed but whose stamp
was lost be completed rather than refused; and it keeps a same-key stampede from refusing
everybody but the creator, because every caller of one key merges the same patch to the
same value, so the peers find the effect already present rather than a moved revision.

A claim is a once-only record rather than a lease, which is why ADR-0019 rule (a) does
not bind it: nobody can take it over, so there is no owner token to re-assert. The guard
on the only value-bearing write is a revision read and used in the same attempt.

### Order notes: keyed by the idempotency key, in a child collection

`order-documents.ts` records why notes are not embedded in the order aggregate: a note is
operator-supplied free text with no natural bound, so embedding it would make the size of
the hot money-path document a function of how much support wrote about it.

The document id is the note's **idempotency key**, not a `{orderId}:{noteId}` composite
as ADR-0019 §4 first had it (the table now carries the corrected form). Three reasons: the
SQL's once-only was `order_notes.idempotency_key` UNIQUE, table-wide; ADR-0019's own
mapping says that constraint "becomes the document id of its claim"; and a composite id
would need a second claim document plus a crash seam between the two to buy nothing,
since no caller holds a note id. Keying on `{orderId}:{noteId}` alone would have been
worse than either — it would make one idempotency key admissible once PER ORDER, which is
weaker than the constraint it replaces, and a case pins the cross-order behaviour.

`listForOrder` pages the declared `orderId` index at 100 and applies
`createdAt ASC, id ASC` in code: the pair has to be sorted together or the tie-break is
not a tie-break, and a note id means nothing to a reader on its own. `createdAt` is
fixed-width ISO-8601, so the comparison is dialect-identical. A list that exhausts its
page budget raises `ScanPageLimitError` rather than truncating, because a short note list
reads as "nobody wrote that". Three cases cover it: a multi-page read, a multi-page read
where every note shares one instant so the tie-break carries the whole ordering across the
cursor, and the ceiling.

### Crash seams proven in this tier

Two of the four stores have a multi-document step, so two have a seam.
`test/misc-crash-seams.dialects.test.ts` (both Node dialects) and
`test/d1/misc-crash-seams.d1.spec.ts` drive each from the forbidden side, in BOTH
injection modes: `"instead"` asks what a missing write leaves behind, `"after"` asks what
a caller who believed it FAILED is told when it retries over a write that really landed.
The second is the shape a retrying webhook, a double-clicked Save and a resubmitted note
all take.

| Crash | Residue | Cost | Heals by |
|---|---|---|---|
| after the grant, before either pointer | a grant no scope points at | one indexed query per missing scope, once | the next `check` on that scope, or a replayed grant |
| after the first pointer, before the second | one scope pointed, one not | as above, for that scope | as above |
| after the mutation claim, before the settings write | a decision with no outcome | the update applies later, or is refused as superseded if something moved the settings first | the next call with that key, at `decidedRevision` only |
| after the settings write, before the result stamp | an applied value with no recorded result | nothing: the completion's merge changes nothing, so it records without writing | the next call with that key |
| the retry budget runs out after the claim was created | as the first settings row | **the update applies LATER, not never** — or not at all, if it is overtaken first | as above |
| a creator lands while a concurrent replay of its key concludes "superseded" | none — the value is applied and stamped | the replay's caller is refused for an update that did land | nothing to heal: re-reading the claim returns the landed result |

Two of those rows are worth reading twice. The budget row is the one residual in this tier
that does not resolve toward over-refusal, so it is named rather than filed under rule (c):
`StorageContentionError` from a settings update whose claim already exists means the
operator's change is decided and unlanded, and the next call with that key lands it — at
`decidedRevision`, or not at all if something has moved the settings since. The error is
retryable and nothing is lost, but the honest statement is "applies later" rather than "was
refused", and a caller that never retries leaves the claim for whoever does. No other step
here has that shape: a grant's budget running out after the grant document landed leaves
the grant authoritative, and both single-document stores write nothing at all.

The last row is the accepted residual of the pin itself. A creator may land its value while
a concurrent replay of the same key, reading a revision the creator's own write has just
moved, concludes "superseded": the value was applied and the replay's caller was refused.
That is over-refusal — never a double apply, never a clobber — and it is the direction this
tier resolves every residual in.

`order_notes` and `payment_events` write one document each, so a lost write leaves NOTHING
and the retry is a clean first attempt rather than a repair — which two `"instead"` cases
assert, since "there is no seam" is a claim that needs evidence too. Their `"after"` twins
assert the other side: a note that landed is returned to its retry as `appended: false`,
and a dedupe row that landed makes the retry a redelivery.

### What this tier does NOT carry

- **No revocation path.** The `EntitlementStore` port has `grant` and `check` and nothing
  else, so the contract's revoke hook is implemented in the test harness as the
  compare-and-set equivalent of the SQL harness's `UPDATE`. It is deliberately not test
  surface on the production store: a revocation path with no caller belongs on the port
  when one arrives.
- **No settings validation.** The port's `update` is a *validated* partial update and the
  domain's `updateSettings` use-case is what validates it. A store that re-validated
  would be a second, drifting copy of a rule the domain owns — and the SQL adapter
  validates nothing either.
- **No anomaly read surface.** See the forward reference above: anomalies are written to
  be alerted on, nothing reads them back, and the prune that will need indexes is owed.

## Reporting rollup document model

Reporting is the one port whose SQL was pure read-time aggregation — one `GROUP BY` over
`orders` joined to `order_totals`, `order_items` and `refunds`, with the period bucket as
a dialect-branched truncation. There is no join, no aggregate and no raw SQL here, so two
of the four reports moved to write time and two did not:

| Report | Where it is computed |
|---|---|
| `revenueByPeriod` | `reporting_daily`, paged by the `date` range, folded to day / week / month |
| `ordersByStatus` | the same scan, folded over `stateCounts` |
| `topProducts` | on read — a scan of `orders` over the FROZEN line snapshots |
| `lowStock` | on read — a scan of `inventory`, titled through the live sku claim |

| Document | Contents |
|---|---|
| `reporting_daily/{currency}:{YYYY-MM-DD}` | the orders CREATED that UTC day in that currency: `stateCounts`, `revenueOrders`, `revenueCents`, `refundEntries`, `refundedCents` |
| `reporting_applied/{orderId}:{from}>{to}` · `{orderId}:refund:{refundId}` | one rollup event, claimed — and, once a recompute has counted it absolutely, `absorbedAt`. Indexed by `date` (how a recompute pages a day's claims) and `orderId` (the diagnostic axis) |

**The day is the grain, and the other two intervals are folds over it.** A week is the
seven day documents from its ISO Monday and a month is its own days, so nothing is keyed
by a week or a month and no second aggregate can disagree with the first. That is only
sound because every boundary is UTC and every coarser bucket is a union of whole UTC
days — which is exactly what `date_trunc(…, AT TIME ZONE 'UTC')` and `strftime(…)`
computed, so the fold and the statement agree by construction rather than by testing.

**The bucket is the order's CREATION day, never the day anything happened to it.** A
transition on an order placed three months ago moves three-month-old counters, and a
refund issued today lands in the day the order was placed. Both follow from the port:
revenue is bucketed on `orders.created_at` and counts only orders whose CURRENT state is
in the allow-list, and a bucket's `refundedCents` answers "what did the orders placed in
this period give back", which is the only reading under which the two figures in one row
are comparable.

**A transition is a MOVE, and revenue moves with it.** `ordersByStatus` needs every state,
including the excluded ones, so the state the order leaves is decremented and the state it
enters is incremented. The revenue figure cannot be derived from those counts — it sums
totals rather than counting orders — so the event carries the order's net total and
revenue enters or leaves according to the allow-list. A refund is not a transition and is
not driven by one: it adds to the day's returned money whatever the order's state is,
which is what keeps a fully refunded order's money reportable.

**`revenueOrders` and `refundEntries` are not decoration.** They are how a bucket's
EXISTENCE is decided: the SQL emitted a row as soon as either half contributed, so a
genuinely zero-total order in a revenue-counting state is a row at `revenueCents: 0` and
not an absence. Counting the contributors rather than testing the sums is the only way to
tell those two apart. **The money is part of the test as well**, though: a bucket is
reported when either counter is above zero OR either sum is non-zero, because a counter
that drift has taken to zero over a non-zero sum is a day that is holding money, and
dropping it would hide exactly the figure a merchant would come looking for.

**Flooring is announced, because it is proof of drift.** A decrement that would take a
counter below zero is clamped — no report should be able to show negative revenue — and
`EmdashReportingStoreOptions.onAnomaly` is called with the counter, the day document, the
order and the two numbers. An operator seeing one should run a recompute over that day.
The flag deliberately does NOT live on the document: a recompute would erase it in the
same write that fixes the day, so the record of the drift would disappear with the drift
itself, whereas the observer has already reached the log.

### The claim is written first, and the residue is an under-count

One event is two documents and there is no transaction between them:

```
claim     reporting_applied/{claim} create-if-absent — the once-only gate
counters  reporting_daily/{currency}:{day} compare-and-set — the value
stamp     the claim's `appliedAt`, best-effort, as a DIAGNOSTIC
```

A crash between the first two leaves the event spent and the counters short: the report
says less money than came in and leaves the order in a state bucket it has already left.
The other order — counters first — would leave an event unclaimed whose delta had already
landed, and its redelivery would count the same money twice. Between an under-count that
heals and an over-count that compounds, this tier resolves toward the first (cross-cutting
rule (c)).

`appliedAt` is therefore never a gate. A claim with a null stamp may or may not have moved
the counters, because the crash could have landed on either side of the write, so nothing
reads it to decide whether to apply — it exists to make the residue legible.

Every decrement is also **floored at zero**, which is the one place this adapter tolerates
being wrong: a decrement whose matching increment was lost would otherwise drive a counter
negative and report negative revenue, a number no report should be able to show.

### The recompute is the definition

`reconcile(range)` rebuilds each day document from a paged scan of the orders created that
day. A recompute commits an ABSOLUTE value while a live event commits a DELTA, so running
both against one document has exactly two failure modes — the recompute erasing a
transition it did not see, and a delta landing on top of a recompute that already counted
it. Three mechanisms close them, in the order the code does them:

1. **Pin before scanning.** Every day document an attempt may write has its revision read
   BEFORE the orders are scanned, so a live delta landing in between costs the recompute
   its commit and forces a re-scan. Scanning first and pinning afterwards is the bug that
   ordering exists to prevent: the value in hand would predate the transition and the
   revision would not say so.
2. **Absorb the claims the scan proves, before committing.** A claim is the right to move
   these counters; a recompute that has counted the event absolutely spends that right, and
   `absorbedAt` is how the claim says so. The claims absorbed are exactly the ones
   RECONSTRUCTED from the scanned orders — never every claim an order has — because a
   transition that is not in the scanned document is one the recompute did not count, and
   absorbing it would drop its delta.
3. **Every delta re-reads its claim immediately before every bucket write** and skips
   itself when it has been absorbed (cross-cutting rule (a): the token is re-asserted
   before each write it guards, on every attempt, because this path retries with backoff
   and a writer parked past the moment its right was revoked must not commit anyway).

The claims are reconstructed from the order itself: its append-only audit log carries every
`(fromState → toState)` pair, its refunds ledger every finalized refund, and the arrival
into its original state is the event creation owes. An amount carried on a reconstructed
claim is diagnostic only — nothing recomputes from a claim.

A day that has lost every order keeps a ZEROED document rather than being deleted: a live
event racing that write needs a revision to lose to, and an all-zero document reads as no
bucket at all.

**Reconcile a CLOSED day as a matter of course, and a live day only on demand.** Yesterday
and older have no live events to race, so an attempt cannot lose its pin and the work is
one pass; the current day is still receiving events, so a recompute over it may have to
re-run and can leave the residue below. The page budget is per day, so a long range is
bounded by construction — a caller sweeping a large history should still chunk it, a month
at a time, to keep one call's work and one call's retries bounded.

**The absorb pass is budgeted and indexed.** A day's claims are read by the axis they are
filed under — `date`, which is the order's creation day and so the day being recomputed —
as pages of ONE indexed query, and the pass costs **one unit per claim-index page and one
unit per claim absorbed**, the same unit a page of orders costs. A claim an earlier run
already absorbed costs neither, being skipped before any spend and any write.

A budget refusal from this pass arrives as a `ScanPageLimitError` naming operation
`absorbReportingClaims` and option `maxReconcilePages`: the operation says it was the claims
rather than the orders that exhausted the budget, and the option is the same knob either way.

Both shapes this replaced were unbounded in something that grows: a read per reconstructed
event is a round trip per transition every order has ever made, paid on every attempt and
every sweep, and a query per ORDER makes the cost a function of how many orders the day
holds — so a large day would exhaust its budget and never heal. Every extra round trip also
widens the window in which a live delta invalidates the pin.

The ceiling that follows is a function of how many claims an order carries — one per
transition and one per finalized refund — rather than of the order count alone. At the
default budget, for a day whose claims are already absorbed (the steady state, and every
closed day after its first heal), the cost is `orders/100 + claims/100` units: at about two
claims per order that clears tens of thousands of orders in a day, and more claims each
lowers it proportionally. A day healed from nothing pays a unit per claim as well, which is
where the real limit sits at a few hundred orders' worth of first-time absorption per call.
Chunk a bigger history, or raise the budget.

**The residues, all in the under-counting direction.** A transition that lands after the
scan read its order but before the absorb reaches its claim is absorbed without having been
counted, and its delta is then skipped; a process that dies between the absorb and the
commit leaves the same shape; a failed attempt leaves claims absorbed whose counters it
never committed, so a day that loses its pin repeatedly reads lower each time until a run
succeeds; and a range whose later days exhaust the page budget leaves the earlier days
committed and the rest untouched. Every one of them is a day that reads low until the next
successful run, and none of them can double-count, because nothing applies a delta whose
claim is absorbed.

### The hook on the order store is additive, and never fatal

`EmdashOrderStoreOptions.reporting` defaults to a no-op. It is called after the order
write it describes is durable — inside the guarded flip, past the compare-and-set that
committed and past the outbox locator, so it fires exactly once per WON write and a lost
flip owes nothing — and the four sites are the flip, `recordRefund`'s finalized insert,
`finalizeRefund`, and the create-if-absent that lands a new order (whose arrival into
`pending` the status counts need).

Every call is wrapped in a try/catch that swallows. By the time it runs the state write
has committed, so a throw would tell the caller its transition failed when it did not —
the worst possible lie about a payment. What is lost instead is a counter, in the
under-counting direction, and the recompute restores it. The retry helper would not absorb
the throw either: it only re-runs on a retryable storage abort.

### The window is exact, whatever instants it names

A day document is the counters for a WHOLE day, so it can only answer for a day the window
covers whole. The interior of a window is therefore read from the documents, and each EDGE
day the window truncates — at most two, and only when a bound is not midnight — is computed
from an instant-filtered scan of that day's orders, the same machinery `topProducts` uses.

So `created_at BETWEEN from AND to` means the same thing here as it did in the statement
this replaced, to the instant. The cost of a ragged window is visible and bounded — two
extra order scans, paid only by the caller that asks for one — and the aligned windows a
day-bounded report asks for pay nothing.

One consequence is worth knowing before reading a ragged report: an edge day is computed
from the ORDERS, so it is exact even when the rollups have drifted, while an interior day
carries whatever its document holds. A single report can therefore mix an exact edge with
an interior day that is reading low until the next recompute.

### Reporting crash seams proven

`test/reporting-crash-seams.dialects.test.ts`, each case reading the documents back before
it heals:

| Seam | What survives | What heals it |
|---|---|---|
| claim landed, counters did not | claim, un-stamped; counters short | `reconcile`, and the redelivery is then a no-op |
| counters landed, the caller never learned | counters moved; claim present | nothing to heal; the redelivery is refused by the claim |
| crash before the claim | nothing applied | the redelivery applies it exactly once |
| transition durable, rollup lost | the order in its OLD state bucket, no revenue claimed | `reconcile` |
| refund durable, rollup lost | the order's day at `refundedCents: 0` | `reconcile`, into the order's creation day — never the day the refund was issued |
| the CLAIM write landed and the caller then died | a spent claim over counters that never moved | only `reconcile` — every redelivery is a no-op, however often it is retried |
| a decrement arriving with no matching increment | the counter floored at zero, the day's money still on the document | `reconcile`; meanwhile the anomaly observer has announced it and the bucket is still reported |

### Reporting contention, measured

The day document's bound is the CROWD rather than the document: every distinct event
legitimately moves a counter, so nothing refuses anybody and a writer can lose its revision
once per peer that commits ahead of it. That is the shipping/tax-rules shape, not the
inventory one.

**The shape that would exceed it is a BATCH**, not a busy shop: a hold-expiry sweep or a
bulk fulfilment run flips many orders at once, and if those orders were placed on the same
day they all contend for one document. Past roughly the ceiling the surplus writers raise
the typed contention refusal — which the order store's hook swallows, because reporting
must never fail a transition — so the day reads low until a recompute fixes it. That chain
is the designed degradation: batch → contention → swallowed → under-count → healed.

**Measured max CAS attempts: 12 at N=24 transitions into one day document (4 loops),
against `CAS_MAX_ATTEMPTS` = 24** — `test/reporting-bucket-race.pg.test.ts`, which also
races N=16 deliveries of ONE event and asserts a single delta. No contention refusal occurs
at that size; the headroom is what the extra attempts buy, and a busier day spends more of
it before the typed, retryable refusal rather than reporting a wrong total.

### What the reporting tier does NOT carry

- **Nothing constructs it yet.** No caller builds `EmdashReportingStore`, and nothing passes
  `reporting` to the order store, so the tier is dormant: the rollups are written only by a
  store that was explicitly wired to write them. **Both collections must also be declared on
  the plugin descriptor before any read can answer** — an undeclared collection is a
  missing-collection error, and an undeclared index is a runtime query error, so the
  declaration is part of turning this on rather than a detail of it.
- **No scheduling.** `reconcile` is a method, not a cron job. Wiring it to a periodic hook is
  a later change, along with every other heal this package owes.
- **No product or stock rollups.** `topProducts` and `lowStock` are computed on read, for
  the reasons above. If either ever needs a rollup it needs its own document, not another
  field on the day.
- **No cash-flow view.** Refunds are bucketed by the ORDER's creation day, which answers
  "what did the orders placed in this period give back". "What refunds were ISSUED in this
  period" is a genuinely different report and would need its own document and endpoint.
