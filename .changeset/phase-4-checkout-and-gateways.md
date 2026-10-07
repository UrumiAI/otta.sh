---
"@otta-sh/domain": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/payments-x402": minor
"@otta-sh/plugin": minor
---

Phase 4 — checkout + payment gateways.

- `@otta-sh/domain`: the immutable order model (price+title snapshot) and the
  Phase-4 ports — `OrderStore`, `EntitlementStore`, `PaymentEventStore`, and one
  `PaymentGateway` seam fitting both Stripe (async webhook) and x402
  (synchronous page-gate). Use-cases: `createOrderFromCart` (snapshot from
  `product_commerce`, `order_totals` stub, order-row-before-adoption ordering,
  guarded `held→adopted` flip, cart `checked_out` flip; digital lines reserve
  nothing), `settleOrder` (verify→dedupe→transition→commit-or-grant; amount
  equality vs `order_totals.total`; loud 0-row-commit anomaly +
  manual-reconciliation flag distinguished from the benign already-committed
  replay; `payment_failed`→release), and `expireOrders` (real orders-table
  guarded `pending→expired`). Additive `InventoryStore.adopt` + widened
  `commit`/`release`, `CartStore.checkout`, the cart add/increase digital branch,
  and `product_commerce.title`. In-memory fakes +
  `orderStoreContract`/`entitlementStoreContract`/`paymentGatewayContract`.
- `@otta-sh/payments-stripe` (new): raw-body HMAC-verifying Stripe adapter + the
  offline fake-Stripe driver `signStripeWebhook`. The webhook secret comes from
  the host environment only, never the wire.
- `@otta-sh/payments-x402` (new): page-gate adapter that re-verifies the facilitator
  receipt SERVER-SIDE via an injected `X402Facilitator` (never trusting the
  plugin) + an offline HMAC facilitator. `transaction` is the dedupe key.
- `@otta-sh/plugin`: sandbox-clean PUBLIC entitlement-gated download route, which
  checks the entitlement before serving a byte. **The Stripe webhook cannot be a
  plugin route** — EmDash's sandboxed-route bridge JSON-parses the request body
  (destroying the raw bytes the HMAC verifies) and pins the HTTP response to a
  wrapped 200 (Stripe retries key on status), so a byte-exact proxy is
  structurally impossible, and the plan says so (§9 Risk 1).

Entitlements are keyed on `order_id` + `buyer_ref` (email/session claim token);
Phase 5 re-associates them to customer accounts.

Review-round hardening (settle-path defect family):

- `settleOrder` no longer short-circuits on a duplicate `dedupe_key` — every
  delivery **re-drives the idempotent, state-guarded steps** (guarded flips,
  `provider_ref`-keyed payment record, state-guarded commit, grant-once
  entitlement), so a crash between dedupe→flip or flip→commit/grant (and
  markFailed→release) is healed by the next gateway retry instead of silently
  no-oping while the order expires.
- Losing the `pending→paid` flip to a **mid-flight** expiry/failure is now as
  loud as finding the order already terminal: a new `PAID_FLIP_LOST`
  `payment_events` anomaly + the manual-reconciliation flag (money captured,
  stock released — never silent).
- `InventoryStore.commit` is guard-first: it flips only a `held` or `adopted`
  hold, and a no-op re-reads to distinguish the benign already-`committed`
  replay from the loud lost-hold anomaly.
- Stripe webhook verification enforces a configurable **freshness window** on
  the signed `t` (default 300s, injectable Clock) and checks **all** `v1`
  signatures (secret rotation).
- The x402 adapter rejects a receipt settled on a network outside the
  gateway's `accepts`, and the facilitator swap-in point documents the
  load-bearing production requirements (attest amount + recipient; the
  amount==`order_totals.total` check and tx-hash dedupe are what bind a
  receipt to an order — `orderId` is never on-chain-attestable).

Review round G (second review):

- **The plugin's Stripe webhook proxy route was removed** — the host bridge
  destroys the raw bytes and the status code, so the proxy validated a
  fictional contract (see the `@otta-sh/plugin` bullet above).
- `createOrderFromCart` enforces the **cart-state fence**: a checked-out cart
  with a distinct idempotency key is rejected `CART_CHECKED_OUT` (same-key
  replays still honored via `OrderStore.getByIdempotencyKey`); order-driven
  releases are **order-scoped** (`InventoryStore.releaseAdopted`) so a stale
  order can never free — or crash the sweep on — a hold it never adopted.
- A **physical line with no reservation** (product flipped digital→physical
  after add-to-cart) fails creation loudly (`RESERVATION_LOST`) instead of
  minting an order that would settle with zero inventory committed.
- A line priced in a **different currency than the cart** is rejected
  (`CURRENCY_MISMATCH`) instead of being summed into the cart-currency total.
- Settle short-circuits **terminal states before the amount check**, so a
  mismatched-amount stray duplicate on an already-paid order no-ops instead of
  recording a false `AMOUNT_MISMATCH` anomaly.
- Wiring x402 **fails closed**: the only facilitator that can be wired is the
  offline test one, so enabling it is an explicit opt-in that warns loudly it
  is not production-safe.

Known deferrals (Phase 5+): Stripe `createIntent` offline stub; the entitlement
check's buyerRef enumeration oracle (closed by Phase-5 claim tokens; marked
in-code).
