---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Cancel an order WITH a structured reason (detail optional), and make the cancelled-
notification email carry WHY instead of a reason-free notice (admin-UX Increment 1,
"cancel with reason" slice). Before this slice, cancelling was a bare `POST
.../transition {toState:"cancelled"}` — no reason captured, and the cancelled email said
only "Your order has been cancelled." Discovery: cancelling has never released reserved
stock in this domain (only `pending → expired`'s guarded sweep and settle's failed-payment
path do that, per the Phase 5 design doc); this slice does not change that — it is
out of scope here and preserved exactly as-is.

The core design decisions:

- **Single-slot cancellation.** `cancelled` is terminal (no outbound transition in the
  state machine), so an order carries at most ONE `OrderCancellation` (reason / detail? /
  cancelledBy / cancelledAt) — a struct on the order, not a child table.
- **Cancelling IS recording the reason.** `cancelOrder` composes with the state machine
  (the exact `recordFulfillment` shape): it writes the reason envelope AND drives the
  `{pending,paid,processing} → cancelled` transition AND enqueues the cancelled email, all
  atomically. So no reachable state is "cancelled with no reason" via this path. Legality is
  DERIVED from `isLegalOrderTransition(state, "cancelled")` — never a hardcoded state list —
  so it automatically covers every state the machine allows to cancel. Mutable-envelope
  only — it NEVER touches line items, prices, or totals (the snapshot invariant); it does
  NOT release inventory (that gap, if any, is unchanged and out of scope). The bare
  `POST .../transition` stays available for other callers/back-compat — a cancellation via
  that path carries no reason (`cancellation === null`), mirroring `recordFulfillment`'s
  shipped-without-tracking case.

- **Domain (`[Domain]`).** New `Order.cancellation` field + `OrderCancellation`/
  `CancellationReason` types (`customer_request | fraud_suspected | out_of_stock |
  pricing_error | other`); new `OrderStore.cancelOrder` port method (a guarded
  `WHERE state=:fromState` flip that writes the cancellation columns, cancels the order,
  and enqueues the cancelled outbox row in ONE transaction, routed through the SAME
  `#flipAndEnqueue` primitive as `transition`/`recordFulfillment` — never a parallel copy);
  new pure use-case `cancelOrder` (validate → derive legality → delegate; idempotent
  replay + the stale-race disambiguation mirror `recordFulfillment`/`transitionOrder`).
  `buildOrderEmailData` now carries the cancellation so the cancelled template can render it.
- **Adapters (`[Adapters]`).** Forward-only migration `0013_order_cancellation` adds four
  nullable columns to `orders` (portable text DDL, identical on better-sqlite3 + pg). Both
  adapters green against the new `orderCancellationContract`; Postgres additionally runs the
  concurrency races — N concurrent cancels resolve to exactly one winner, and cancelling
  racing `recordFulfillment` resolves to exactly one outcome (the order is never both
  cancelled and shipped) — extending PR #63's record-vs-cancel race to the reasoned path.
- **Service (`[Service]`).** `POST /admin/orders/:id/cancel` mirrors the use-case 1:1 under
  the internal-token guard + the X-Service-Token write gate (a non-GET); `serializeOrder`
  gains `cancellation` (additive). `renderEmail`'s `order-cancelled` template renders the
  reason ONLY through an explicit CUSTOMER-SAFE allowlist (`customerSafeCancellationCopy`):
  `customer_request` → "at your request", `out_of_stock` → "an item was unavailable";
  everything else — `fraud_suspected`, `pricing_error`, `other`, or any unknown value —
  renders NO reason line at all (just the generic cancellation body, same as a
  bare-transition cancellation), and the admin's free-text `detail` NEVER reaches the
  customer email for ANY reason value. The full reason + detail stay admin-only, on the
  order detail page.
- **Plugin (`[Plugin]`).** The order detail gains a "Cancellation" section: a still-
  cancellable order shows a danger-styled alert + the cancel form (reason select, optional
  detail, cancelledBy) and the bare "Mark cancelled" one-click is HIDDEN from the transition
  buttons (UI steering, extending PR #63's shipped-steering precedent — cancelling goes
  through the form so an order is never cancelled without a reason; the service still
  accepts the bare transition for other callers); a cancelled order shows the recorded
  reason read-only; a cancelled-without-reason order gets an honest note. A
  `NOT_CANCELLABLE` conflict surfaces a "reload" notice, not a token-check error. Typed
  `ctx.http` client method threads both tokens like the transition; sandbox-clean
  (Block Kit only) — verified in the workerd-on-Node sandbox.
