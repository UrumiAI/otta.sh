---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

A declined card no longer fails the order (ADR-0021, #304). Stripe keeps a PaymentIntent
payable after a decline and the pay page retries on the same client secret, so failing the
order and releasing its stock and coupon at `payment_intent.payment_failed` turned the
everyday "first card declined, second card accepted" sequence into a charged buyer, released
stock and a manual-reconciliation flag.

- **`settleOrder`**: a verified `failed` confirmation is recorded in `payment_events`
  (deduped, bound to its order) and moves nothing — the order stays `pending`, its holds stay
  adopted and its coupon use stays consumed. A later `succeeded` settles it normally; an order
  nobody pays is expired by `expireOrders`, which releases its stock and coupon as for any
  abandoned checkout. A late decline on a paid or expired order is a no-op, not an anomaly.
- **State machine**: `pending → failed` is removed. `failed` remains an `OrderState` —
  terminal, unreachable — for orders failed before this change. The admin console no longer
  offers a bare "failed" transition on a pending order (it released no stock).
- **Breaking (pre-1.0)**: `OrderStore.markFailed` is removed from the port, the in-memory fake
  and `EmdashOrderStore`; `SettleDeps.couponStore` is removed (settlement no longer touches
  coupons).
- **New contract**: `paymentDeclineContract` in `@otta-sh/domain/testing`, run on the fakes
  and on the document store over SQLite, Postgres and D1.
- **Coupon sweeper**: the cron's `coupon-orphans` leg again releases a redemption whose
  order is `expired`, as the retry for `expireOrders` (whose durable `pending → expired`
  flip precedes the coupon release, so a crash in between would otherwise leak the use).
  `cancelled` orders still keep their coupon, as before.
