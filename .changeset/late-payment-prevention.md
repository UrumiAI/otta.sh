---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/plugin": minor
---

An expired order's PaymentIntent is withdrawn, so it can no longer be paid (ADR-0022, amended
again 2026-10-02). The automatic late-payment refund makes such a payment safe; this makes it
rare.

- **Intents are recorded.** `createOrderFromCart` records every intent it mints
  (`OrderStore.recordPaymentIntent` / `listPaymentIntents`, idempotent per intent; a failed write
  is logged and never fails the checkout). A new intent is due for withdrawal at the order's
  `holdExpiresAt`; the guarded `pending → paid` flip resolves it (`not_needed`) in the same
  write; `cancelOrder` from `pending` makes it due at once.
- **A bounded sweep withdraws them** — never the expiry itself. `cancelDueIntents` (new) drains
  due intents (`listIntentCancelsDue` / `updatePaymentIntentCancel`), with a batch limit, a
  `shouldContinue` budget and lazily-resolved gateways; it cancels once per intent of an order
  that left `pending` unpaid, reschedules a RETRYABLE or throwing cancel with backoff up to
  `maxAttempts`, gives a TERMINAL one up, and never touches an order that is still pending. The
  plugin runs it as a new, best-effort cron leg, `cancel-intents`, inside the sweep's tick
  budget right behind the critical legs (one due query when idle, no deferral noise; measured
  `LEG_QUERY_COSTS` entry 5 / unit 5, `LEG_SHARES` 0.2 time / 0.3 queries,
  `batchesFor(...).intentCancels` 1–10, the tick's gate as `shouldContinue`, each cancel given a
  fixed 1.5 s and started only with that much left — `canStartCancel` — so a tick running out
  never costs an attempt); the order ledger
  read (`readOrderLedger`) now carries `paymentIntents`, so the leg reads each order once.
- **`PaymentGateway.cancelIntent`.** `StripePaymentGateway` calls
  `POST /v1/payment_intents/{id}/cancel` (`cancellation_reason=abandoned`, native
  `Idempotency-Key`, path-escaped id) bounded by the new `DEFAULT_CANCEL_TIMEOUT_MS` (3 s,
  `cancelTimeoutMs` on the transport, capped at each call by `requestTimeoutMs`); `payment_intent_unexpected_state` is `not_cancellable`;
  no secret key is `UNSUPPORTED`. `StripeTransport.cancelPaymentIntent` is optional, so existing
  transport seams keep compiling. `X402PaymentGateway.cancelIntent` answers `UNSUPPORTED`.
  `FakePaymentGateway` gains `cancelIntent`, `cancelCalls` and `setCancelResult`.
- **Store:** `EmdashOrderStore` keeps `paymentIntents` on the order document with an indexed,
  derived `intentCancelDueAt` (both absent on existing documents).
- **Contract:** `intentCancelContract` in `@otta-sh/domain/testing`, run on the fakes and on
  the document store over SQLite, Postgres and D1.
- **Breaking (pre-1.0):** `PaymentGateway` requires `cancelIntent`; `OrderStore` requires
  `recordPaymentIntent`, `listPaymentIntents`, `listIntentCancelsDue` and
  `updatePaymentIntentCancel`; `SWEEP_LEGS` gains `cancel-intents`.
