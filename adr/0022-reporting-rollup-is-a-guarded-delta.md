# 0022. The reporting rollup is one guarded numeric delta per event

- Status: accepted
- Date: 2026-09-29
- Refines: [ADR-0019](./0019-commerce-aggregates-are-one-document-each.md) — its two-tier write
  strategy, for the reporting day document only. ADR-0019's tiers, its single-guard rule and every
  other aggregate are unchanged; this record adds one named exception to that rule and says why it is
  safe.

## Context

`reporting_daily/{currency}:{YYYY-MM-DD}` holds the counters for every order created that UTC day in
that currency. Every checkout, settle and refund on that day moves it, and the order store awaits the
rollup inline. It was written by ADR-0019's general tier: a `compareAndSet` read-modify-write with
bounded, jittered retry.

That tier is right for an aggregate whose writers can be refused by an invariant. This one has no such
invariant: every distinct event legitimately moves a counter, so nothing refuses anybody, and a writer
loses its revision once per peer that commits ahead of it. The retry depth grows with the crowd. At 200
concurrent events on one day, 120–176 writers exhausted the 24-attempt budget
(`StorageContentionError`, swallowed by the order path as an under-count), each after up to a second of
inline backoff.

ADR-0019's lock-free tier (`updateIf`, arithmetic in SQL) removes that cost, but its rule is that
`updateIf` carries only "a write whose entire invariant is one comparison on one field". A rollup
event needs more than that: it must not land on top of a recompute that already counted it absolutely
(the claim's `absorbedAt`, ADR-0019 cross-cutting rule (a)), and a recompute must not commit over a
delta it never saw. The host's `updateIf` also never moves a document's revision, so a revision pin
cannot see a delta at all.

## Decision

**1. One event is one guarded `updateIf`.** The claim (`reporting_applied`, create-if-absent) stays the
once-only gate. The counter write is then a single `updateIf` whose `delta` carries the arithmetic and
whose `where` carries only:

- the day document's **`epoch`**, as read BEFORE the event's claim was checked; and
- a **floor** guard (`>= dec`) per counter the event decrements.

It also bumps **`seq`**. Peers' deltas never guard on each other, so the crowd costs row-lock queueing
and nothing else: the retry depth is 1 at N=200, pinned by `reporting-bucket-race.pg.test.ts`.

**2. Two guards, not a revision.**

- `seq` is bumped by every delta. A recompute pins `(epoch, seq)` before it scans and commits with an
  `updateIf` guarded on both, so a delta landing mid-recompute costs it the commit and forces a
  re-scan.
- `epoch` is moved by a recompute's commit (and by a migration or un-taint, below). A delta parked
  across a commit that absorbed its claim is refused by its own statement, re-reads its claim, and
  skips itself. A commit bumps the epoch even over an already-exact document when it absorbed claims.

**3. The single-guard rule's exception, and why it holds.** The delta's guard is more than one
comparison, but every comparison is either the writer's own right to write (the epoch) or a floor on
the counter it moves; none couples a writer to its peers, so the crowd never refuses anybody. The
refusal is still decided by a re-read, never by `applied: false`. The one coupling is drift: when a
counter is already below a decrement, the floor is taken against the exact value read, so peers moving
that counter re-plan it once per write. That path only runs on drift, which is itself evidence for a
recompute and is announced as a `floored` anomaly.

**4. The stored shape changes, forward-only.** Counters are stored flat (`state_<state>` fields beside
`revenueCents` and the rest) because the host's delta addresses top-level fields only. A LEGACY
document (nested `stateCounts`, no guards) is read as it stands and migrated forward by a revision
compare-and-set on the first write that has a reason to touch it; no delta lands on a legacy document,
since every delta is guarded on `epoch`. `ReportingDailyDoc` (what readers see) and the
`ReportingStore` port are unchanged.

**5. Mixed versions and rollback.** A deploy must be atomic (`DEPLOYMENT.md` §5): because `updateIf`
never moves the revision, a PREVIOUS-version Worker's compare-and-set succeeds over a current
document.

- An old worker's **rollup** spreads the document it read and adds a nested `stateCounts` map built
  from nothing: a **hybrid** (tainted) document. Deltas that landed after its read are discarded, and
  its own state move lives only in the nested map. New code reads a hybrid by its flat fields alone.
  The next live event **un-taints** it with ONE `updateIf` guarded on the `(epoch, seq)` read, which
  sets `stateCounts: null` and moves `epoch` past every epoch it knows of, announces a `tainted`
  anomaly, and then applies its own delta. It does **not** recompute the day inline: that would put a
  full-day scan, with no single-flight, on every checkout during the window. The discarded deltas are an
  under-count that `reconcile` heals; a recompute always rewrites a hybrid it finds.
- An old worker's **reconcile** writes the legacy shape. New code migrates it forward on first write,
  as in (4), at an epoch past the one the writer already held where it has one.
- So `epoch` only increases **except across a mixed-version window**, where an old writer can write
  back an older epoch or drop it. Parked deltas that a rewound epoch lets through are healed by
  `reconcile` like any other residue of that window.

## Consequences

- Busy days no longer refuse or back off on the checkout path; the cost of a rollup event is one claim
  create, one read and one write.
- The exactly-once and reconcile-safety arguments are unchanged in substance. The epoch replaces the
  old per-attempt claim re-read, and the check and the write are now one statement.
- The rule "`updateIf` is for one comparison on one field" gains one documented exception. A future
  `updateIf` family has to make the same argument: every guard is the writer's own right or a floor,
  and none couples it to its peers.
- Deploys that change a stored document's shape must be atomic. A rollback past this release leaves the
  current day's figures provisional until it is reconciled; orders, stock and payments are unaffected.
- Readers must accept two stored shapes (and the hybrid) indefinitely, since migrations are
  forward-only and a document that is never written again is never migrated.
