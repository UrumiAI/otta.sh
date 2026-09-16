---
"@otta-sh/plugin": patch
---

Run the admin Orders console on the plugin's own store.

`InProcessAdminOrdersClient` is the in-process twin of `AdminOrdersClient` — the
same twelve methods (`listOrders`, `getOrder`, `transitionOrder`,
`resolveReconciliation`, `recordFulfillment`, `cancelOrder`,
`getCustomerContext`, `getTimeline`, `getRefunds`, `refundOrder`, `listNotes`,
`addNote`), the same argument shapes and the same return values field for field,
with the `@otta-sh/domain` use-cases composed over the `@otta-sh/store-emdash`
adapters bound to `ctx.storage` instead of a commerce service. No egress:
`ctx.http` is never touched.

No field is narrowed. `ListPayload.total` is always present on a page this tier
served and an absent total is never spelled `0`; `cursorRejected` is only ever
`true`; the detail's `transitions` stay derived from the domain state machine
rather than re-listed; `deletedAt` keeps its tombstone semantics; and
`shippingAddress` stays the immutable checkout snapshot (ADR-0009), never a
re-read of a live address record. The refunds summary keeps both
`refundedTotalCents` — the watermark the refund action reads — and the gateway's
honest `refundable`.

Three pieces of the service's route layer are behaviour rather than framing and
are mirrored here: the orders list's opaque cursor (position + filter + limit)
with its re-validation on decode and the fail-closed filter/limit disagreement
check plus the one-shot page-one recovery, the wire serializers, and ADR-0008's
refund ceiling — `computeRefundCeiling(Σ captured, frozen total)` less `Σ`
non-voided refunds, floored at zero — which lives in the route and so is ported
here rather than routed through a helper that does not exist. Route-level
idempotency fallbacks (`admin:transition:…`, `admin:resolve-reconciliation:…`,
`admin:fulfillment:…`, `admin:cancel:…`, `admin:note:…`) are preserved, and a
refund still REQUIRES a key (`MISSING_IDEMPOTENCY_KEY`) because it is additive.

Refund EXECUTION is not wired on this tier yet: no payment gateway has moved
in-process (INC-C1/C3), so a well-formed refund against a real order answers the
route's own `409 REFUND_GATEWAY_UNAVAILABLE` where the HTTP tier, which composes
a gateway, answers `409 REFUND_EXCEEDS_CAPTURED`. Both refuse, both leave the
ledger untouched, and each side is pinned by its own gated case.

`makeAdminClients` now routes `orders` as well as `products`; rules and reporting
arrive with their own increment and an absent surface stays absent rather than
being stubbed. The admin Orders console route reads its client through the
factory instead of constructing an HTTP one directly.

The client contract's admin-orders slice now runs on BOTH transports from the
same cases — the in-process tier over a real per-collection repository on SQLite,
the HTTP tier over a live service on Postgres. Order search is asserted at the
ADR-0019 §6 floor (id prefix, folded buyer-ref prefix, exact folded line sku) and
never at a tier's ceiling: the Postgres dialect's unanchored buyer-ref substring
is a sanctioned superset, so each tier pins its own side of that divergence in
its own file.
