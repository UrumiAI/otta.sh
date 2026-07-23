---
"@urumi/domain": minor
"@urumi/payments-stripe": minor
"@urumi/payments-x402": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Order refunds (ADR-0008) — money movement made honest, in the smallest shape that
preserves every invariant.

- **Port:** `PaymentGateway.refund(input): Promise<RefundResult>` + a `readonly
  refundable: boolean` capability flag. The domain and admin UI branch on the flag
  — never a `try/catch` to discover refundability.
- **Ledger:** a new append-only `refunds` table with the ceiling `Σ refunds ≤
  min(Σ captured payments, order_totals.total)` enforced ATOMICALLY in a
  row-locked guarded write (`OrderStore.recordRefund`) — no read-modify-write, no
  over-refund under any interleaving. `UNIQUE(idempotency_key)` is the once-only
  backstop. The frozen order snapshot (`order_items`/`order_totals`) is never
  touched. A FULL refund (Σ reaches the ceiling) drives `→ refunded` through the
  existing `#flipAndEnqueue` choke point (guarded flip + `order-refunded` email +
  audit event); a partial records the row and does not transition ("partially
  refunded" is a derived badge).
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
