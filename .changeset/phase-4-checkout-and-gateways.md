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
- `@urumi/store-postgres`: forward-only migration `0004_orders` (`orders` with no
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
- `@urumi/plugin`: sandbox-clean PUBLIC Stripe webhook proxy (base64-exact raw
  body, proven byte-exact under workerd against the live service) + an
  entitlement-gated download route; `HttpCommerceClient.checkEntitlement`.

Entitlements are keyed on `order_id` + `buyer_ref` (email/session claim token);
Phase 5 re-associates them to customer accounts.
