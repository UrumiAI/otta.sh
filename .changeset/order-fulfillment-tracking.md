---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Record shipping fulfillment (carrier, tracking number, optional tracking URL, ship date)
on an order, and make the shipped-notification email carry that tracking instead of being
empty (admin-UX Increment 1, "fulfillment + tracking" slice). Before this slice there was
no fulfillment/tracking model at all: "shipped" was a bare state reached by a plain status
transition, and the shipped email said only "Your order is on its way."

The core design decisions:

- **Single-slot fulfillment.** This domain's state machine ships an order exactly once
  (`processing → shipped`, one `shipped` state — no partial/split fulfillment), so an order
  carries at most ONE `OrderFulfillment` (carrier / trackingNumber / trackingUrl? /
  shippedAt / recordedBy / recordedAt) — a struct on the order, not a child table.
- **Recording fulfillment IS shipping.** `recordFulfillment` composes with the state
  machine: it writes the tracking envelope AND drives the `processing → shipped` transition
  AND enqueues the shipped email, all atomically. So no reachable state is "shipped without
  tracking" (via this path) or "fulfilled but not shipped", and the shipped email always
  carries tracking. Legality follows the machine's grain — fulfillment is legal ONLY from
  `processing` (the sole pre-`shipped` state); any other state (pending/paid/cancelled/…, or
  an order already shipped by the bare transition) is `NOT_FULFILLABLE`. Mutable-envelope
  only — it NEVER touches line items, prices, or totals (the snapshot invariant).

- **Domain (`[Domain]`).** New `Order.fulfillment` field + `OrderFulfillment` type; new
  `OrderStore.recordFulfillment` port method (a guarded `WHERE state=:fromState` flip that
  writes the fulfillment columns, ships the order, and enqueues the shipped outbox row in ONE
  transaction — the `transition` fromState-guard precedent; the adapter routes through the
  SAME `#flipAndEnqueue` primitive as every other transition, never a parallel copy); new
  pure use-case `recordFulfillment` (validate → derive legality from
  `isLegalOrderTransition(state, "shipped")`, never a hardcoded state list → delegate;
  idempotent replay + the stale-race disambiguation mirror
  `transitionOrder`/`resolveReconciliation`). `buildOrderEmailData` now carries the
  fulfillment so the shipped template can render it.
- **Adapters (`[Adapters]`).** Forward-only migration `0012_order_fulfillment` adds six
  nullable columns to `orders` (portable text DDL, identical on better-sqlite3 + pg). Both
  adapters green against the new `orderFulfillmentContract`; Postgres additionally runs the
  concurrency races — N concurrent record-fulfillment ship exactly once (one shipped email),
  and record-vs-cancel resolves to exactly one winner (the order is never both).
- **Service (`[Service]`).** `POST /admin/orders/:id/fulfillment` mirrors the use-case 1:1
  under the internal-token guard + the X-Service-Token write gate (a non-GET);
  `serializeOrder` gains `fulfillment` (additive). `trackingUrl` is scheme-bound to http(s)
  at the boundary (defense-in-depth — the value is emailed to the buyer; `javascript:`/
  `data:` URIs are a 400, never storable). `renderEmail`'s `order-shipped` template now
  renders the recorded carrier / tracking number / tracking URL (escaped), degrading to
  the plain body when an order shipped without fulfillment.
- **Plugin (`[Plugin]`).** The order detail gains a "Fulfillment" section: a `processing`
  order shows the record-fulfillment form (honest copy that recording ships the order and
  emails tracking) and the bare "Mark shipped" one-click is HIDDEN from the transition
  buttons (UI steering — shipping goes through the form so an order is never shipped
  without tracking; the service still accepts the bare transition for other callers); a
  shipped order shows the recorded tracking read-only; a shipped-without-
  tracking order gets an honest note. A `NOT_FULFILLABLE` conflict surfaces a "reload"
  notice, not a token-check error. Typed `ctx.http` client method threads both tokens like
  the transition; sandbox-clean (Block Kit only).
