---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Order timeline + state-change audit (admin-UX Increment 1, timeline slice — the
last slice of the order-detail build). The admin order detail now shows a
chronological timeline of everything that happened to an order — state
transitions (with who/when), fulfillment recorded, cancellation with reason,
reconciliation resolved, and notes — and every state change is durably audited
going forward.

The core design decisions:

- **Choke-point audit capture.** After PR #63/#64, ALL order state flips
  (`transition`/`markPaid`/`markFailed`/`expire`/`recordFulfillment`/`cancelOrder`)
  route through ONE shared primitive — `#flipAndEnqueue` (a guarded `WHERE
  state=:fromState` UPDATE + the outbox INSERT in one transaction). This slice
  extends THAT primitive (and the in-memory fake's equivalent) to also INSERT one
  append-only `order_events` row IN the same transaction. So every state change
  self-audits with no behavior change to the flips themselves, and — because the
  event is written only after the guarded flip matched a row — a replayed or
  lost-race flip is a 0-row miss that records NO event (audit never double-counts
  a replay; this falls straight out of the choke-point design and is tested,
  including under a Postgres race).

- **Merge vs. write, per artifact.** `order_events` is kept lean — it is ONLY the
  state-change spine (the history nothing else recorded before). Everything that
  already carries its own durable timestamp is MERGED at read time, never
  double-written: creation (`order.createdAt`), notes (`order_notes`), fulfillment
  (`order.fulfillment.recordedAt` + carrier/tracking/recorder), cancellation
  (`order.cancellation.cancelledAt` + reason/detail/canceller), and reconciliation
  resolution (`order.reconciliationResolution.resolvedAt` + outcome/reason/
  resolver). The fulfillment/cancel flips ALSO stamp their recorder/canceller as
  the state-change event's `actor` (the who this domain knows); bare transitions
  (`markPaid`/`expire`/generic) have no modeled actor and record `null`.

- **Graceful degradation for historical orders.** Orders whose transitions
  predate this migration have no `order_events` rows. The timeline read-model
  degrades: their creation moment, notes, and any recorded fulfillment/
  cancellation/resolution still populate the view, and a `stateChangesAudited`
  flag (false) lets the surface say the state-change history is partial. Events
  are recorded from THIS release onward.

- **Domain (`[Domain]`).** New `OrderEvent`/`OrderEventKind` types + `OrderStore.
  listEventsForOrder` port read; new pure use-case `getOrderTimeline` (merges the
  event spine with the derived artifacts into one chronological view with a stable
  same-timestamp tie-break: `at` ASC, then a kind rank, then insertion order).
- **Adapters (`[Adapters]`).** Forward-only migration `0014_order_events` adds the
  append-only `order_events` table (portable text DDL, identical on better-sqlite3
  + pg) with the `(order_id, at, id)` list index. The event INSERT rides
  `#flipAndEnqueue`'s transaction; both adapters green against the new
  `orderTimelineContract`, and Postgres additionally proves exactly-one audit
  event under a concurrent-flip race (extending the fulfillment race too).
- **Service (`[Service]`).** New `GET /admin/orders/:id/timeline` — read-only,
  internal-token guarded like the other admin reads — mirrors the use-case 1:1
  (structured entries on the wire; no presentation strings, no money, no PII
  beyond what the order detail + notes already show).
- **Plugin (`[Plugin]`).** The order detail gains a read-only "Timeline" section:
  one chronological when/what/who/detail table merging the state changes with the
  notes and recorded actions, an honest caption when the state-change history is
  partial, and independent degradation (a failed timeline read renders an
  "unavailable" section, never blanking the detail). Typed `ctx.http` client
  method; sandbox-clean (Block Kit only) — verified in the workerd-on-Node sandbox.
