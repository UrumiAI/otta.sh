---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/payments-stripe": minor
"@urumi/payments-x402": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Phase 4 — checkout + payment gateways.

- `@urumi/domain`: the immutable order model (price+title snapshot) and the
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
- `@urumi/store-postgres`: forward-only migration `0005_orders` (`orders` with no
  money column, insert-once `order_items`, 1:1 `order_totals` authoritative
  totals home, `payments`, `payment_events` dedupe+anomaly, `entitlements`;
  additive `reservations.order_id`/`adopted` + `product_commerce.title`). Kysely
  order/entitlement/payment-event adapters, `adopt`/`checkout` guarded flips.
  Green on better-sqlite3 and Postgres including **no-oversell-through-checkout**,
  snapshot immutability, the adopted-hold sweep invisibility, the double-sweep
  expiry race, the cart fences, and the loud commit-lost anomaly.
- `@urumi/payments-stripe` (new): raw-body HMAC-verifying Stripe adapter + the
  offline fake-Stripe driver `signStripeWebhook`. Webhook secret is service-env
  only.
- `@urumi/payments-x402` (new): page-gate adapter that re-verifies the facilitator
  receipt SERVER-SIDE via an injected `X402Facilitator` (never trusting the
  plugin) + an offline HMAC facilitator. `transaction` is the dedupe key.
- `@urumi/service`: `POST /checkout/orders`, `GET /orders/:id`,
  `POST /internal/expire-orders`, the raw-body `POST /webhooks/stripe`,
  `POST /entitlements/grant`, and `GET /entitlements/check`; the cart add route
  resolves fulfillment kind server-side; product-commerce carries `title`. Live
  HTTP contract green.
- `@urumi/plugin`: sandbox-clean PUBLIC entitlement-gated download route;
  `HttpCommerceClient.checkEntitlement`. **The Stripe webhook endpoint is the
  SERVICE's public URL (`POST /webhooks/stripe`)** — there is deliberately no
  plugin proxy route: EmDash's sandboxed-route bridge JSON-parses the request
  body (destroying the raw bytes the HMAC verifies) and pins the HTTP response
  to a wrapped 200 (Stripe retries key on status), so a byte-exact proxy is
  structurally impossible; direct-to-service is the plan's preferred design
  (§9 Risk 1).

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
- `KyselyInventoryStore.commit` is guard-first (conditional
  `UPDATE … WHERE state IN ('held','adopted') RETURNING`; 0 rows re-reads to
  distinguish the benign already-`committed` replay from the loud lost-hold
  anomaly).
- Stripe webhook verification enforces a configurable **freshness window** on
  the signed `t` (default 300s, injectable Clock) and checks **all** `v1`
  signatures (secret rotation).
- The x402 adapter rejects a receipt settled on a network outside the
  gateway's `accepts`, and the facilitator swap-in point documents the
  load-bearing production requirements (attest amount + recipient; the
  amount==`order_totals.total` check and tx-hash dedupe are what bind a
  receipt to an order — `orderId` is never on-chain-attestable).

Review round G (second review):

- **Stripe webhooks are direct-to-service** — the plugin proxy route was
  removed (see the `@urumi/plugin` bullet above; the host bridge destroys the
  raw bytes and the status code, so the proxy validated a fictional contract).
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
- The service bin **fails closed on x402**: configuring `X402_PAYTO` +
  `X402_FACILITATOR_SECRET` without `X402_ALLOW_TEST_FACILITATOR=true` refuses
  to start (the only wireable facilitator is the offline test one); the opt-in
  warns loudly that it is not production-safe.

Known deferrals (Phase 5+): Stripe `createIntent` offline stub;
`GET /entitlements/check` buyerRef enumeration oracle (closed by Phase-5 claim
tokens; marked in-code).
