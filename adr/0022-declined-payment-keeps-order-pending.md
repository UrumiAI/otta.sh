# 0022. A declined payment keeps the order pending

- Status: accepted
- Date: 2026-09-29
- Decided by: the maintainer, 2026-09-29 (issue [#304](https://github.com/UrumiAI/otta.sh/issues/304))
- Refines: the Phase-4 settlement design (`settleOrder`, §5) and the Phase-5 order state
  machine. Amends no earlier ADR.
- Amended: 2026-10-02 — the "success after expiry" path: a payment that lands on an order
  that provably left `pending` unpaid is refunded automatically; and (second block) the window
  itself is narrowed — the order's PaymentIntent is withdrawn once it is due, and the pay page
  refuses an order that can no longer be paid. See the two "Amended 2026-10-02" sections at the
  end of this record.
- Amended: 2026-10-05 — a late payment Otta cannot refund says "refund it in Stripe", and the
  delayed-webhook case (a buyer who paid in time is refunded) is recorded as accepted. See the
  last section.

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
   past the order total, the ceiling refuses it and it goes to a human (amended 2026-10-05: the
   flag says "Otta cannot refund it … refund it in Stripe directly", not "refund it manually").
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

## Amended 2026-10-02 (second block) — the late-payment window is narrowed at the source

The block above makes a late payment safe. This one makes it rare: "cancelling the
PaymentIntent when an order expires would close that last window and is a separate change" —
this is that change, plus the pay page refusing an order that can no longer be paid.

1. **Intents are recorded, and due at the hold.** Checkout records every PaymentIntent it
   mints on the order (`OrderStore.recordPaymentIntent`, idempotent per intent; a list, because
   Stripe's ~24 h key expiry can mint a second). A new intent is DUE for withdrawal at the
   order's `holdExpiresAt`. The guarded `pending → paid` flip resolves the order's intents
   (`not_needed`) in its own write, so a paid order never reaches the sweep; an admin cancel of a
   *pending* order makes them due at once.
2. **Withdrawn by their own sweep leg, never by the expiry.** `expireOrders` stays a pure
   state-and-stock transition: putting a provider call per order on the path that releases stock
   would let a slow or down Stripe hold stock hostage. The cron's `cancel-intents` leg
   (`cancelDueIntents`) runs inside the sweep's tick budget (ADR-0019's cadence amendment),
   right behind the three critical legs (the outbox and the expiry pair) and ahead of the
   completers: one due query when idle (no deferral noise); a measured ~5 calls per order (one
   of them the Stripe cancel) plus up to ~5 secret reads to build the gateway, capped at 20% of
   the tick's time and 30% of its queries, 1–10 orders per tick scaled from the query budget,
   each unit admitted by the tick's gate, one ledger read per order, the gateways resolved once
   from the COUNTED context and only when a unit needs them, and each Stripe cancel given a FIXED
   1.5 s and started only with that much left — so its timeout is always the provider's, and a
   tick running out never costs one of the five attempts
   (`POST /v1/payment_intents/{id}/cancel`, `cancellation_reason=abandoned`, the
   intent-derived key as its native `Idempotency-Key`). It cancels once per intent of an order
   that left `pending` unpaid. An intent that already succeeded is `not_cancellable` — the buyer
   paid at that instant, and the block above refunds it. x402 holds no standing intent and
   answers `UNSUPPORTED`.
3. **Retries are the leg's alone.** A RETRYABLE (or throwing) cancel is rescheduled with backoff
   and retried by this leg on later ticks, up to a bounded number of attempts; a TERMINAL one is
   given up at once. Nothing else re-asks the provider — not the expiry, not settle. Giving up is
   safe: a payment on an intent this never withdrew lands on a dead order and is refunded.
4. **The pay page refuses** an order that is not `pending` or whose hold has passed
   (ADR-0012's 2026-10-02 amendment).

**Cadence on Workers Free.** The cancel leg is best-effort and runs after the three critical
legs; on the Free preset, under an expiry backlog, those can use the whole minute, so a cancel
may wait behind them for a while. That is acceptable precisely because prevention is backed by
the refund: a payment on an intent not yet withdrawn lands on a dead order and is refunded.

**The gap that remains, recorded.** The sweep runs every minute, but within a budget — on
Workers Free under a backlog the expiry legs advance about one order a minute — so an order can
sit `pending` past its hold until the expiry reaches it. The pay page refuses it, and its intent is not
withdrawn until the expiry has run (the leg never cancels an order that could still settle
cleanly). A buyer who pays in that gap — from a page loaded before the hold lapsed — settles the
order normally, exactly as this record's original decision intends; its adopted stock is still
held, so the settle commits it. Only if that hold had been lost would the settle raise the
existing loud `COMMIT_LOST` anomaly and flag the order — the same path any lost hold takes.

The new `intentCancelContract` (`@otta-sh/domain/testing`, fakes and the document store over
SQLite, Postgres and D1) pins all of the above. The order document gains `paymentIntents` and an
indexed `intentCancelDueAt`.

## Amended 2026-10-03 — `cancel-intents` runs first; late refunds rank above housekeeping

ADR-0019's amendment of this date reorders the sweep's tick. Two points concern this record:

1. **`cancel-intents` runs FIRST in every tick**, ahead of the expiry. A payment intent due for
   withdrawal is withdrawn before anything else can spend the minute. The second block above
   put it right behind the three critical legs, and on Workers Free under an expiry backlog
   those could use the whole minute, so a cancel waited. One subtlety: the intents of the orders
   this tick's expiry bite is about to flip are left for a second, cheap due check right after
   that flip, in the same tick. A store that waits for the expiry before withdrawing such an
   intent would otherwise push it back a recheck interval at the head and miss it after the flip.
   Every other due intent — a lapsed order the bite will not reach this tick included — is
   withdrawn at the head. The backlog suite pins that the leg is never deferred.
2. **`late-refunds` ranks above housekeeping** (after the money legs and the outbox), not last.
   On the Workers Free preset it still leads one tick per fifteen minutes while refunds are
   pending, and now ahead of even `cancel-intents`. A resume is about 25 calls and needs a tick
   nothing else has touched. The money it returns has already been taken. That tick's intent
   cancels and expiries wait one minute together, so no order expires that minute with its
   intent still live. The lead stamp is written when the lead is tried, so a lead the tick
   cannot fit does not keep the money legs waiting tick after tick. The give-up escalation still
   runs at the head (right after `cancel-intents`) in every other minute.
3. **The starvation guard can go ahead of it** (ADR-0019's amendment of this date, item 9): a
   leg passed over nine ticks in a row runs before `cancel-intents`, once. In such a tick a due
   withdrawal may wait about one more minute; if the starving leg is `expire-orders`, an order may
   expire before its intent is withdrawn. A payment in that minute is kept while the order is still
   held, and refunded automatically once it has expired — the late-payment path of the first block.
   **Superseded by QA round 3 (ADR-0019's QA-round-3 amendment):** the expiry no longer flips an
   order whose intent is due and not yet withdrawn, so in a guard tick the withdrawal and the
   expiry wait together. The intents this tick's expiry bite would flip are no longer left for a
   run after the flip either: `cancel-intents` withdraws every due intent it lists.

The decision of this record is unchanged.

## Amended 2026-10-03 — the intent is withdrawn at the deadline, and a payment before the expiry is a sale

QA round 2 found buyers still being charged and then refunded on expiring orders (QA2 M1). The
store owner's decision stands: a late charge is **prevented** — the PaymentIntent is withdrawn
when the order's time to pay runs out — and refunded if it still lands. Three causes, three
changes, and one decision recorded.

1. **Withdrawn at the deadline, not after the expiry (M1a).** The leg used to push a due cancel
   back five minutes at a time while the order was still `pending`, "never withdrawing the
   intent of an order that could still settle cleanly". Under an expiry backlog that left the
   order expired with its intent still payable, which is exactly the window the previous block
   set out to close. Past its hold an order can no longer be paid by any honest path — the pay
   page refuses it on load (ADR-0012) and now closes itself at the deadline in an open tab, and
   resume refuses it — so `cancelDueIntents` now withdraws a due intent whether the order is
   still `pending` past its hold or has already left `pending` unpaid. The order keeps its stock
   until the expiry runs; the expiry stays a pure state-and-stock transition (decision 2 above is
   unchanged). An intent is never withdrawn before its order's hold.

   **The gap that remains** is the time between the deadline and the next sweep tick that
   reaches the intent: about a minute, since `cancel-intents` runs first in every tick (the
   amendment above); one minute more in a tick the `late-refunds` lead or the starvation guard
   puts ahead of it. A payment confirmed in
   that gap (only from a client that ignored the page's own deadline, or one confirmed in the
   final seconds and still `processing`) is handled by decision 4 below while the order is
   `pending`, and refunded once it has expired. The previous block's paragraph "The gap that
   remains, recorded" is superseded by this one.

2. **Each cancel attempt has its own idempotency key.** `cancel-intent:<intentId>` for the first
   attempt, `cancel-intent:<intentId>:<n>` after. Stripe saves the first result for a key —
   failures included — and replays it, so a retry under the same key could never get past a
   transient 500. A repeat cancel is harmless: a withdrawn intent stays withdrawn.

3. **A refused cancel is read, never assumed (M1b).** Stripe answers
   `payment_intent_unexpected_state` whenever the intent is not in a status it cancels from at
   that moment. It cancels from `requires_payment_method`, `requires_confirmation`,
   `requires_action`, `requires_capture` and, rarely, `processing`
   (<https://docs.stripe.com/api/payment_intents/cancel>). The adapter mapped that code straight
   to `not_cancellable` and the leg resolved the intent, although the PI was still payable
   (orders 621a6c23, 04250058). The Stripe transport now reads the PaymentIntent, inside the
   cancel's own time bound: `succeeded` is `not_cancellable` (the payment landed — settle accepts
   or refunds it), `canceled` is `cancelled`, and any other status or a failed read is
   RETRYABLE, so the leg asks again on a later tick under a fresh key. The port's
   `not_cancellable` now means "the intent succeeded" and nothing else.

4. **Decision: a payment that settles after the deadline but before the expiry is accepted
   (M1d).** The order is still `pending` and its adopted stock is still held, so settling it
   oversells nothing; refusing it would refund a buyer who did nothing wrong and cost the
   merchant the fee for no one's benefit. This is the original decision of this record, kept
   deliberately. After the expiry the same payment is late and refunded (the first amendment).
   The copy matches: the pay page's closed notice says "If you paid just before, your order page
   shows whether the payment arrived in time — a payment that arrived too late is refunded", and
   a lapsed pending order's page says "if the order has expired by then, your payment will be
   refunded".

5. **"Start a new cart" cancels the cart's unpaid order (QA2 X4).** Its copy said it cleared
   any payment still in progress; it cleared cookies only. `/checkout/new-cart` now first calls
   the public `storefront/order/abandon` route with the cart cookie (the same possession proof
   resume accepts). If the order that cart became is still `pending`, it is cancelled with the
   plain cancel (`customer_request`, by `shopper`) — which releases its held stock and, by
   block 2's point 1, makes its intent due for withdrawal at once — and a payment that still
   lands is refunded like any payment on a cancelled unpaid order. A paid, expired or already
   cancelled order is not touched. If the cancel cannot be confirmed (busy, unreachable) the
   site clears nothing and says so, rather than drop the shopper's only handle on a live order.

`intentCancelContract` gains the deadline-withdrawal, accept-before-expiry and per-attempt-key
cases (fakes and the document store on SQLite; Postgres and D1 run the same suite in CI); the
Stripe transport's cancel tests cover every status; the commerce-client contract and the
sandbox cover the abandon route.

## Amended 2026-10-05 — what the late-payment cure cannot do, recorded (issue #364)

Two edges of the first block, found reviewing the QA stack (#357). Neither changes a decision.

1. **A second late payment that would pass the order total is refunded in Stripe, by a
   person.** The refund ceiling is `min(Σ captured, frozen total)` (ADR-0008). When an expired
   order has taken two full late payments, the first auto-refund uses the whole ceiling and the
   second is refused at reservation (`REFUND_EXCEEDS_TOTAL`): nothing is issued, and no refund
   from Otta's console can return it either — the ceiling refuses that too. The flag used to say
   "refund it manually", which sent the operator to a button that refuses. It now says "Otta
   cannot refund it — this order's refunds already reach its total … refund it in Stripe
   directly, then resolve this flag". The order page keeps saying the payment will be refunded
   (`refund_pending`) until the flag is resolved as refunded. Raising the ceiling for this case
   was not done: the ceiling is the over-refund guard for every other path, and two full late
   payments on one order need a client that ignored both the pay page's deadline and the
   withdrawn intent, which is rare enough to leave to a person. `latePaymentContract` pins it.

2. **A delayed webhook can auto-refund a buyer who paid in time — accepted.** The cure keys on
   the order's state when the success is *settled*, not on when Stripe captured the money. If
   the buyer paid before the deadline but the `payment_intent.succeeded` delivery reaches Otta
   only after the sweep has expired the order (a Stripe delivery delay, or our endpoint down
   for a while), the order is dead, its stock is back on sale and may already be sold, and the
   payment is refunded like any late one. We accept it because:
   - the alternative — reviving the order from the capture time — could sell stock that the
     expiry released and someone else bought: an oversell, the one thing this system refuses;
   - the refund is the safe direction: the buyer gets all the money back and one email saying
     so, and nobody is charged for goods they will not get;
   - the window is narrow: the expiry runs after the hold, not at it, so the delivery has to be
     late by more than the gap between the deadline and the expiry tick.
   **What the operator sees:** a `SETTLE_ON_NON_PENDING` anomaly on the order ("refunding
   automatically"), the refund on the ledger by `otta:auto-refund`, and the reconciliation flag
   already resolved as `refunded` with the reason "Payment arrived after the order was expired;
   refunded automatically". Nothing waits on them. A merchant who wants the sale can ask the
   buyer to order again.
