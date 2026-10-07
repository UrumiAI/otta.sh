---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/plugin": minor
---

A payment that lands on an expired order is refunded automatically (ADR-0022, amended
2026-10-02). Before this, a buyer who kept the pay page open past the hold could pay; Stripe
captured, the order stayed `expired` with a manual reconciliation flag, the order page said
"Nothing was charged", and nobody was refunded or told.

- **`settleOrder` cures late payments** (`refundLatePayment`). On a dead order
  (`expired`/`cancelled`/`failed`) the capture is always recorded. When the order provably left
  `pending` unpaid (`leftPendingUnpaid`: for `cancelled`, a `pending → cancelled` audit event —
  orders that predate the audit log stay manual) and the gateway can refund, the payment is
  refunded through `refundOrder` under ONE key per captured payment
  (`latePaymentRefundKey(providerRef)`), so redeliveries and concurrent deliveries never
  double-refund; the flag is resolved (`refunded`, by `otta:auto-refund`) and one notice is
  enqueued. Failures reword the flag by what a human should do (retrying / verify at the
  provider / refund manually). A transient failure returns the new `SettleFailure`
  `LATE_PAYMENT_REFUND_RETRYABLE` and schedules a per-refund retry with backoff
  (`lateRefundRetryDelayMs`: 5 min → 15 min → 1 h); after `LATE_REFUND_GIVE_UP_MS` (~3 days) — a
  missing gateway counting as a transient failure — it gives up: reservation kept
  `unverified`, never voided.
- **`retryLatePaymentRefunds`** resumes reserved late-payment refunds once the provider stops
  redelivering — a TRIMMED unit (~20 calls; `refundOrder` accepts the ledger the caller just
  read), gated per refund, a refund past the age limit given up without a provider call — and
  **`escalateStaleLateRefunds`** gives such refunds up on any budget (no provider call). The
  plugin runs both in a new best-effort cron leg, `late-refunds`: one due query when idle (no
  deferral noise), last in the tick — except, only where a unit cannot fit there (Workers
  Free), one LEADING tick per fifteen minutes capped at one unit — and the escalation (its own
  age-ranked list, `OrderStore.listRefundRetriesStale`; it finishes an already-`recorded`
  refund rather than flagging it) at the head of every other due tick; each unit
  admitted only with room for a pre-flight, a whole 2.5 s create and the writes after it
  (`LEG_QUERY_COSTS` entry 5 / unit 20, `LEG_SHARES` 1.0 time / 0.4 queries,
  `batchesFor(...).lateRefunds` 1–5).
- **Notices on the outbox.** `OrderStore.enqueueNotice(orderId, { kind, amount, currency })`
  adds a non-transition email row, first-wins per `(order, kind)`; `OutboxEmail.notice` carries
  the payload, and the dispatcher renders `emailTemplateForNotice` with the notice's own amount
  (the refund, not the order total). New `OrderNotice` type and `order-late-payment-refunded`
  `EmailTemplate`.
- **Store ports:** `readOrderLedger` (order + events + payments + refunds in one read),
  `scheduleRefundRetry(orderId, key, retry | null)` (per refund) / `listRefundRetriesDue`.
  `EmdashOrderStore` implements them (a `refundRetries` map and a derived, indexed
  `refundRetryAt` on the order document — absent on existing documents) and stores the notice
  payload on the outbox entry.
- **Domain additions:** `classifyLatePayment`, `readOrderWithLatePayment`,
  `leftPendingUnpaid`, `isUnpaidTerminalState`, `providerRefOfLateRefundKey`,
  `LATE_PAYMENT_REFUNDED_BY`, `lateRefundRetryDelayMs`, `LATE_REFUND_GIVE_UP_MS`; `RefundOrderCommand.providerRef`
  (optional) targets a specific captured payment; `latePaymentContract` in
  `@otta-sh/domain/testing`; `FakePaymentGateway.clearRefundResult`.
- **`StripePaymentGateway`** accepts `requestTimeoutMs` for its default transport — a number,
  or a function asked at each call (a cron leg passes what its budget has left) — plus
  `refundCreateTimeoutMs` (a FIXED bound for the refund create) and `beforeRefundCreate` (asked
  between the pre-flight and the create; `false` answers the new `RefundFailureReason`
  `NOT_STARTED` having issued nothing — `refundOrder` maps it to `GATEWAY_NOT_STARTED`, which the
  late-payment path does not count as an attempt).
- **Plugin:** the Stripe settle route builds a refund-capable gateway when the secret key is
  set, bounds each call at 3 s (`SETTLE_PROVIDER_TIMEOUT_MS`), and answers the retryable
  failure as a 503 with `retryable: true` (the BUSY convention); `stripeGatewayFromCtx` /
  `resolvePaymentGateways` take a `requestTimeoutMs`; the public order wire (`PublicOrderWire` /
  `PublicOrderView`) gains `latePayment: "none" | "refunded" | "refund_pending"`.
- **Breaking (pre-1.0):** `OrderStore` requires `enqueueNotice`, `readOrderLedger`,
  `scheduleRefundRetry`, `listRefundRetriesDue` and `listRefundRetriesStale`;
  `RefundFailureReason` and `RefundOrderFailure` gain `NOT_STARTED` / `GATEWAY_NOT_STARTED`; `OutboxEmail` requires `notice`;
  `PublicOrderWire` requires `latePayment`; `SWEEP_LEGS` gains `late-refunds`.
