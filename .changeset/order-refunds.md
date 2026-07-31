---
"@otta-sh/domain": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/payments-x402": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Order refunds (ADR-0008) — money movement made honest, in the smallest shape that
preserves every invariant.

- **Port:** `PaymentGateway.refund(input): Promise<RefundResult>` + a `readonly
  refundable: boolean` capability flag. The domain and admin UI branch on the flag
  — never a `try/catch` to discover refundability.
- **Ledger + reserve-before-issue:** a new append-only `refunds` table (with a
  `status` lifecycle column) where the ceiling `Σ ACTIVE refunds ≤ min(Σ captured
  payments, order_totals.total)` is enforced ATOMICALLY under the `orders` row
  lock. For a gateway refund the ledger slot is **RESERVED first** (`reserveRefund`
  wins the ceiling arbitration and inserts a `reserved` row) BEFORE the provider is
  ever called, then the row is **FINALIZED** with the provider `refundRef` on
  success (`finalizeRefund`), **VOIDED** on a terminal/fail-closed leg (capacity
  released, audit row kept), or **HELD unverified** on an ambiguous timeout
  (capacity kept — the safe direction — pending a human re-check). So no
  interleaving can let money leave the gateway without a ledger row already holding
  its capacity — ceiling arbitration always precedes issuance (proven by
  gateway-interleaved Postgres races). ACTIVE = every non-`voided` row (finalized +
  held reservations); the `→ refunded` flip counts FINALIZED (`recorded`) rows
  only. The manual/record-only path (x402) stays the one-shot atomic
  `recordRefund` (reserve+finalize collapsed). `UNIQUE(idempotency_key)` is the
  once-only backstop; the frozen order snapshot is never touched. A FULL refund
  drives `→ refunded` through the existing `#flipAndEnqueue` choke point; a partial
  records the row and does not transition. The impossible-by-construction
  "issued-but-unrecorded" residual records a loud `REFUND_UNRECORDED` anomaly with
  the provider refundRef + a reconciliation flag and returns a DISTINCT reason —
  never a silent drop.
- **Stripe = real, x402 = honest.** The Stripe adapter gains a live outbound
  transport seam: a mandatory refund-time pre-flight reads `amount_refunded` and
  **fails closed** (`PROVIDER_ALREADY_REFUNDED`) before issuing, then
  `refunds.create` passes our key as Stripe's native `Idempotency-Key`, with an
  explicit live-error taxonomy (retryable / terminal / ambiguous-timeout →
  "unverified, re-check"). `secretKey` unset ⇒ `refundable:false`. x402 declares
  `refundable:false` and records a manual, out-of-band refund. Contract-tested
  offline via an injected mock transport.
- **Service:** `POST /admin/orders/:id/refund` (write-gated, Idempotency-Key
  required) + `GET /admin/orders/:id/refunds` (ledger + ceiling/remaining +
  honest capability).
- **Plugin:** a Refunds section on the admin order detail — the ledger, remaining
  refundable, a money-input refund form whose framing is honest per gateway
  (real Stripe refund vs record-a-manual x402/off-platform refund), and refreshed
  cancel/reconciliation copy now that a real refund path exists.

Deferred per the ADR: no auto-restock, no line-level refunds, no inbound
`charge.refunded` webhook consumption (a visibility gap the pre-flight bounds).
