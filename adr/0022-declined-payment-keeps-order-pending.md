# 0022. A declined payment keeps the order pending

- Status: accepted
- Date: 2026-09-29
- Decided by: the maintainer, 2026-09-29 (issue [#304](https://github.com/UrumiAI/otta.sh/issues/304))
- Refines: the Phase-4 settlement design (`settleOrder`, §5) and the Phase-5 order state
  machine. Amends no earlier ADR.
- Amended: 2026-10-02 — the "success after expiry" path: a payment that lands on an order
  that provably left `pending` unpaid is refunded automatically. See "Amended 2026-10-02" at
  the end of this record.

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

## Amended 2026-10-02 — a payment that lands on a dead order is refunded automatically

**What changed and why.** This record left one window open and named it: "one who pays after
the sweep lands in the existing `SETTLE_ON_NON_PENDING` reconciliation path". End-to-end QA
walked straight through it: a buyer kept `/checkout/pay` open past the hold, paid, Stripe
captured, the webhook verified, the order stayed `expired` with `reconciliationFlag: "settle
on expired"` — and the order page told them "Nothing was charged". No refund, no email. The
flag was correct and useless: the buyer was out of pocket until an operator happened to look.
The maintainer decided the money goes back automatically. (Closing the window itself —
cancelling the intent at expiry and refusing the pay page — is a separate, following change.)

**The amended behaviour** (`refundLatePayment`, called by `settleOrder`):

1. **The capture is always recorded.** A verified success on an `expired`, `cancelled` or
   (historically) `failed` order is written to the payments ledger first, whatever happens
   next — including on the paths that cannot refund it. It is real money held against the
   order, and recording it is what keeps every reader from claiming nothing was charged.
2. **Positive evidence it was never paid.** The refund is automatic only when the order
   provably left `pending` unpaid: `expired` and `failed` can only be entered from `pending`;
   a `cancelled` order needs the `pending → cancelled` flip in its state-change audit. A paid
   order an admin later cancelled has captured money too, and refunding a redelivery of its
   original settling event is the merchant's decision, not the webhook's. An order that
   predates the audit log has no events and therefore no evidence — it stays manual.
3. **Exactly once.** The refund goes through `refundOrder` (ADR-0008's reserve → issue →
   finalize) under ONE key derived from the captured payment,
   `late-payment-refund:{providerRef}`, so any number of redeliveries, concurrent deliveries
   and sweep resumes produce one provider refund and one ledger row. After a non-ok result the
   key's row is re-read, so an attempt that lost to a concurrent, successful one finishes as a
   success instead of flagging a refund that happened. The order's state does not move.
4. **The flag says what a human should do.** It is set to "automatic refund in progress"
   before the provider call, and on success that exact flag is resolved with outcome
   `refunded` by `otta:auto-refund`. On failure it is reworded by what the failure means:
   "retrying" (a transient error — nothing to do), "needs checking … verify in Stripe, it may
   already be refunded" (an ambiguous or already-refunded provider answer — look before acting,
   a second refund would be a loss), and "refund it manually" (a definite refusal).
5. **Retries outlive the webhook — and end.** A transient failure answers
   `LATE_PAYMENT_REFUND_RETRYABLE` (HTTP 503 with the BUSY convention's `retryable` +
   `Retry-After`) so Stripe redelivers, and schedules a retry PER REFUND
   (`OrderStore.scheduleRefundRetry`, keyed by the refund's key, so finishing one late capture
   never drops another's retry), backing off 5 min → 15 min → hourly. Stripe gives up after a
   few days while a `reserved` row keeps holding refund capacity — refusing even an admin refund
   of the same money — so the cron's `late-refunds` leg (`retryLatePaymentRefunds`) resumes it
   under the same key. The leg runs inside the sweep's tick budget (ADR-0019's cadence
   amendment) as a best-effort leg:
   - **idle is free of noise**: one due query; nothing due ⇒ no deferral line, no state write;
   - a **trimmed resume unit** (~20 calls, measured: a `reserved` row proves the capture was
     recorded and the order flagged, so none of that is redone, and the ledger it reads stands
     in for the refund's own reads), gated PER REFUND, 1–5 per tick, ≤40% of the queries;
   - **never a create bound to time out**: the create gets a FIXED 2.5 s, a unit is admitted
     only with 3.5 s left (pre-flight + create + writes), and the gateway skips the create —
     answering RETRYABLE, the row still `reserved` — if the pre-flight ate into that;
   - a create the leg declined to start for lack of time answers `NOT_STARTED`
     (`RefundFailureReason`): nothing issued, no attempt counted, the flag untouched;
   - it runs **last**; only where a unit can never fit there (the Workers Free preset) does it
     **lead one tick per fifteen minutes** while refunds are pending, capped at one unit;
     otherwise a **give-up escalation** (no provider call, its own age-ranked list —
     `listRefundRetriesStale` — so young retries never block a stale one, ~9 calls) runs at
     the head of the tick. Escalation finishes a refund it finds already `recorded` (a `finish`
     that crashed after the finalize) instead of flagging it.
   - **A pattern for future legs.** Two optional hooks on the sweep's leg runner make a
     best-effort leg cheap and quiet: `isDue` (one query; nothing due ⇒ no deferral line, no
     streak, no state write — only a leg with work can be deferred) and `extraCount` (units a
     step outside the leg's body completed this tick, counted in its outcome). A leg that must
     occasionally lead persists its own lead stamp in the sweep state, as `late-refunds`
     does.
   After ~3 days of transient failures (Stripe's own redelivery window) — a missing gateway
   counts as one, so a transient secret miss is not a reason to hand money to a human — it
   GIVES UP, on every preset: the retry is cleared, the reservation is kept and
   marked `unverified` — never voided, since a stalled call may have reached the provider — and
   the flag says "needs checking … verify in Stripe, and refund it manually if it was not
   refunded". The settle path bounds each Stripe call at 3 s, so a refund (a pre-flight read and
   a create) fits inside Stripe's ~10 s delivery timeout. The trade: a create that times out is
   AMBIGUOUS (Stripe may have processed it), so it lands as `unverified` with the "verify in
   Stripe" flag rather than being retried blind. **Known gap:** after a give-up or an
   ambiguous create, a refund made by hand in the Stripe dashboard is invisible to Otta — the
   order page keeps saying the payment "will be refunded" until an admin action confirms it
   (a follow-up: "confirm refunded in provider").
6. **The buyer is told once, with the right figure.** ONE `late-payment-refunded` notice is
   enqueued — a new, non-transition outbox row (`OrderStore.enqueueNotice`, first-wins per order
   and kind), the "new, non-state-transition notification" this record's #26 note anticipated.
   It carries the REFUNDED amount and currency, not the order total. **A second late capture on
   the same order** (a second intent) is refunded the same way under its own key **without a
   second email** — the notice is per kind, not per payment — and if it would take the refunds
   past the order total, the ceiling refuses it and it goes to a human ("refund it manually").
7. **The order page tells the truth.** The public order read carries a derived `latePayment`
   status (`none` / `refunded` / `refund_pending`), read with the order in one document read;
   "Nothing was charged" is said only for `none`. A pending refund is promised only as "it will
   be refunded" — never "automatically": the wire does not say whether a person or the system
   will do it, because on the manual paths it is a person.

**What still goes to a human:** a gateway that cannot refund (x402; Stripe with no secret
key), an order without evidence it was unpaid, a definite refusal, and an ambiguous outcome.

**Consequences of the amendment.** The `paymentDeclineContract` case "success after expiry →
flagged for reconciliation, as before" now asserts the refund; the new `latePaymentContract`
(`@otta-sh/domain/testing`, run on the fakes and on the document store over SQLite, Postgres
and D1) pins the once-only cure, the flag wording, the retry, the concurrent case and the
no-evidence case, the backoff, the give-up and per-refund retries. The order document gains a
per-refund `refundRetries` map and an indexed, derived `refundRetryAt`. A late-payment refund
counts in the reporting rollup's refunded total for its day although the order never counted
as revenue — money really did come in and go back out. ADR-0008's "auto-refund on a settle
anomaly" rejection is narrowed accordingly (its 2026-10-02 amendment).
