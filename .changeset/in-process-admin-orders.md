---
"@otta-sh/plugin": patch
---

Run the admin Orders console on the plugin's own store.

`InProcessAdminOrdersClient` serves the whole admin-orders client contract —
twelve methods (`listOrders`, `getOrder`, `transitionOrder`,
`resolveReconciliation`, `recordFulfillment`, `cancelOrder`,
`getCustomerContext`, `getTimeline`, `getRefunds`, `refundOrder`, `listNotes`,
`addNote`) — with the `@otta-sh/domain` use-cases composed over the
`@otta-sh/store-emdash` adapters bound to `ctx.storage`. No egress: `ctx.http` is
never touched.

No field is narrowed. `ListPayload.total` is always present on a page it
serves and an absent total is never spelled `0`; `cursorRejected` is only ever
`true`; the detail's `transitions` stay derived from the domain state machine
rather than re-listed; `deletedAt` keeps its tombstone semantics; and
`shippingAddress` stays the immutable checkout snapshot (ADR-0009), never a
re-read of a live address record. The refunds summary keeps both
`refundedTotalCents` — the watermark the refund action reads — and the gateway's
honest `refundable`.

Three pieces are behaviour rather than transport framing, and so live on the
client itself: the orders list's opaque cursor (position + filter + limit) with
its re-validation on decode and the fail-closed filter/limit disagreement check
plus the one-shot page-one recovery, the payload serializers, and ADR-0008's
refund ceiling — `computeRefundCeiling(Σ captured, frozen total)` less `Σ`
non-voided refunds, floored at zero. The idempotency-key fallbacks
(`admin:transition:…`, `admin:resolve-reconciliation:…`, `admin:fulfillment:…`,
`admin:cancel:…`, `admin:note:…`) are preserved for a caller that supplies none,
and a refund still REQUIRES a key (`MISSING_IDEMPOTENCY_KEY`) because it is
additive.

Refund EXECUTION is not wired yet: no payment gateway has moved in-process
(INC-C1/C3), so a well-formed refund against a real order answers
`REFUND_GATEWAY_UNAVAILABLE`. It refuses, it leaves the ledger untouched, and it
is pinned by its own gated case.

`makeAdminClients` now routes `orders` as well as `products`; rules and reporting
arrive with their own increment and an absent surface stays absent rather than
being stubbed. The admin Orders console route reads its client through the
factory instead of constructing one directly.

The client contract's admin-orders slice runs against this client over a real
per-collection repository. Order search is asserted at the ADR-0019 §6 floor (id
prefix, folded buyer-ref prefix, exact folded line sku) and never at an
implementation's ceiling — a store that can match more is a sanctioned superset,
and pins that in its own file.
