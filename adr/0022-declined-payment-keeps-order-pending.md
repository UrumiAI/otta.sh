# 0022. A declined payment keeps the order pending

- Status: accepted
- Date: 2026-09-29
- Decided by: the maintainer, 2026-09-29 (issue [#304](https://github.com/UrumiAI/otta.sh/issues/304))
- Refines: the Phase-4 settlement design (`settleOrder`, §5) and the Phase-5 order state
  machine. Amends no earlier ADR.

## Context

`settleOrder` treated a verified `payment_intent.payment_failed` as terminal: it flipped the
order `pending → failed`, released its adopted inventory holds and released its coupon
redemption.

Stripe does not treat a decline as terminal. After a declined attempt the PaymentIntent
returns to `requires_payment_method` and stays payable, and the storefront pay page
(`sites/staging/src/pages/checkout/pay.astro`) keeps the same client secret and calls
`confirmPayment` again when the buyer tries another card. So the everyday sequence
"first card declined, second card accepted" produced:

1. `payment_failed` → the order became `failed`, its stock and coupon were released;
2. `payment_intent.succeeded` for the same order → `SETTLE_ON_NON_PENDING` (or
   `PAID_FLIP_LOST` if it raced) — the buyer was charged, the order was flagged for manual
   reconciliation, and the units they paid for might already have been sold to someone
   else.

Declines are routine (insufficient funds, an abandoned 3-D Secure challenge, a mistyped
number), so this would hit real buyers on an ordinary path.

Three options were considered:

- **A. Keep the order pending (chosen).** A decline is informational: record it and change
  nothing else. The two paths that already exist decide the outcome — the `succeeded`
  settle if the buyer pays, the order-expiry sweep if nobody does.
- **B. Fail and revive.** Keep failing the order on a decline, and teach the `succeeded`
  settle to bring a `failed` order back to `paid` by re-reserving its stock and re-redeeming
  its coupon. Rejected: the stock and coupon use released at the decline can be taken by
  another buyer in between, so a revival can fail after the money has moved — the exact
  outcome this issue is about, made rarer rather than impossible. It also needs a
  `failed → paid` edge in the state machine and a re-reservation path on the settle, i.e.
  more machinery on the money path to undo a transition that should not have happened.
- **C. Fail after N declines.** Count declines per order and fail it on the Nth. Rejected:
  Stripe keeps the intent payable after the Nth decline too, so the same success-after-fail
  race exists at N; any N is arbitrary (a buyer trying three cards is normal); and it adds
  per-order counter state on a path whose job the expiry sweep already does with a clock.

## Decision

1. **A verified `payment_failed` is recorded and moves nothing.** `settleOrder` still claims
   the event's dedupe key in `payment_events` (the audit row: deduped, bound to its order,
   refused if replayed against another order), then returns `{ ok: true, noop: true }`
   without touching the order, its holds or its coupon — whatever state the order is in. A
   late decline delivered after the success, or after expiry, is equally inert and raises no
   anomaly.
2. **Buyer pays → normal settle.** The `succeeded` event finds the order still `pending` with
   its holds still adopted, flips it `paid` and commits the held units exactly once. No
   reconciliation flag.
3. **Nobody pays → the order-expiry sweep.** `expireOrders` (the plugin cron's
   `expire-orders` leg) expires the order once its `holdExpiresAt` passes and releases both
   its stock and its coupon, exactly once. This is the same path every abandoned checkout
   already takes; a declined-and-abandoned order is now simply one of them. Because the
   `pending → expired` flip is durable before the coupon release, a crash between the two
   would otherwise leak the coupon use; the cron's coupon sweeper (`coupon-orphans`)
   therefore also releases a redemption whose order is `expired`, which completes that
   release on a later tick. `release` is idempotent, so the use still comes back exactly
   once.
4. **`pending → failed` is removed from the state machine**, and with it
   `OrderStore.markFailed` (port, in-memory fake and the EmDash store) and
   `SettleDeps.couponStore` (settlement no longer touches coupons). The settle path was the
   only producer of `failed`. The admin console's bare `pending → failed` transition button,
   which the table also offered, was a half-wired path — a bare transition releases no
   stock, and the expiry sweep only sweeps `pending` orders, so it stranded the order's
   holds permanently. For an unpaid order an operator still has **cancel** (records a
   reason and releases the stock, but deliberately releases **no** coupon — the existing
   cancel policy, unchanged here) and the bare **`pending → expired`** transition (releases
   the stock at once; its coupon is not released by the transition itself and is left to
   the coupon sweeper's `expired` arm).
5. **`failed` stays an `OrderState`**, terminal and now unreachable. Orders failed before
   this change still carry it, and every reader — the admin console's list filter and status
   rendering, reporting, the storefront order page — must keep rendering them. It is a
   historical value, not a live transition.

The contract is `paymentDeclineContract` in `@otta-sh/domain/testing`, run on the in-memory
fakes and on `@otta-sh/store-emdash` over SQLite, Postgres and D1: decline → still pending,
stock held, coupon consumed, event recorded once; decline then success → paid, committed
once, no flag; decline and never paid → expiry releases stock and coupon exactly once;
success after expiry → flagged for reconciliation, as before.

## Consequences

- The "declined, then paid with another card" path settles cleanly. The pending order keeps
  its units and its coupon use for the rest of its hold window, so a retry cannot lose them
  to another buyer.
- A declined order holds stock until it expires rather than releasing it at the decline. The
  window is the order's hold (`DEFAULT_CHECKOUT_TTL_MS`, 15 minutes) plus up to one
  run of the plugin's scheduled sweep — the same exposure any abandoned checkout already
  has, accepted as-is. A buyer who pays after the hold lapses but before the sweep runs still
  settles (the order is still `pending`); one who pays after the sweep lands in the existing
  `SETTLE_ON_NON_PENDING` reconciliation path, unchanged by this decision. Cancelling the
  PaymentIntent when an order expires would close that last window and is a separate change.
- Declines are not shown on the admin timeline: the record is the `payment_events` row, which
  the timeline does not merge. Surfacing declined attempts to operators is a possible
  follow-up, not part of this decision.
- **Issue #26 (a payment-failed email).** There is no longer a `pending → failed` transition
  to hang a template on, so #26 as written ("add a template for `pending → failed`") no
  longer applies. The buyer is told about the decline on the pay page by Stripe Elements at
  the moment it happens, and an order that is declined and then abandoned ends `expired`,
  which already sends the `order-expired` email. If an email *per declined attempt* is still
  wanted, it would be a new, non-state-transition notification keyed on the payment event,
  and needs its own decision.
- The domain's public surface narrows: `OrderStore.markFailed` and `SettleDeps.couponStore`
  are gone, and `legalNextStates("pending")` no longer contains `failed`. Pre-1.0, recorded
  in the changeset.
