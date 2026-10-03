# 0026. Admin order actions never claim money that did not move

- Status: accepted
- Date: 2026-10-02
- Decided by: the maintainer, 2026-10-02 (QA findings T1-3, T1-4, T1-6)
- Refines: the Phase-5 order state machine, as the admin console applies it. Amends no earlier
  ADR.
- Numbering: 0025 is reserved by the coupon-codes branch (feat/coupon-codes-case-insensitive),
  which lands it separately.

## Context

QA drove the React Orders console against a store taking real Stripe test payments. It found
admin status moves that told someone money had moved when it had not:

- **T1-3 — Mark paid.** An unpaid Stripe order (Money tab: captured $0.00) was marked paid in one
  click. The buyer received "we've received your payment", and Reports counted $12 of revenue.
  The state machine allows `pending → paid`, and the console offered every legal move.
- **T1-4 — a bare cancel.** The console steers Cancel through the Cancel group, but the server
  still accepted a hand-made `→ cancelled` transition. On a paid card order it cancels with no
  refund, no restock and a "cancelled" email. On any order it records no reason, and it does not
  release the order's adopted stock holds: the bare transition records a release intent only for
  `expired`. The store's `cancelOrder` records both.
- **T1-6 — Mark refunded.** This status-only move sent the buyer "your order has been refunded",
  although it moves no money.

## Decision

A new domain use-case, `transitionOrderAsAdmin`, carries every status move made by hand. It is
`transitionOrder` (the same legality, idempotent no-op and guarded flip) plus three rules.
`adminNextStates` is the matching offer, so the console renders no button these rules would
refuse. A hand-made request is still refused in the domain.

1. **No manual mark-paid, and the rule fails closed.** `pending → paid` is refused with
   `MANUAL_PAYMENT_NOT_ALLOWED` unless the order's payment method is DECLARED offline. The
   declaration is a `Record` over `PaymentMethod` with the values `"gateway"` and `"offline"`, so
   a future bank-transfer or cash-on-delivery method must say which kind it is. Today Stripe and
   x402 are both `"gateway"`: x402's facilitator verify is the same kind of confirmation as
   Stripe's. An order with no method on file is refused too, because nothing about it could have
   been paid. So, today, no order is marked paid by hand; a gateway order becomes paid only
   through the settle path's `markPaid`.
2. **No bare `→ cancelled`, from any state.** It is refused with `USE_CANCEL`, and
   `adminNextStates` never offers it. Cancel order is the admin's one way to cancel. It records
   the reason and, through the store's release intent, frees a pending order's held stock. On this
   build Cancel order does NOT refund or restock a paid order. The refusal's copy, keyed on the
   order's state, says so and points the operator to Money → Refunds. It does not say "refund
   first": a full refund closes the order as `refunded`, after which it cannot be cancelled. The
   Cancel group's label, banner and confirm are keyed on the state the same way, and no longer
   promise released stock on a paid order.
3. **Mark refunded is bookkeeping and emails nobody.** It was kept rather than removed, because it
   is the only way to close an order whose refund was made outside Otta. For a Stripe order the
   ledger cannot record that refund: its pre-flight fails closed on money the provider already
   shows refunded (ADR-0008). The move enqueues no outbox row. Its confirm and its success notice
   ("Marked refunded. No money moved and the buyer was not emailed.") both say so. Money moved
   through Money → Refunds emails the buyer from the ledger write.

`transitionOrder` itself is unchanged. It is the generic state-machine command every suite drives
orders through, and these are rules about who is acting. The admin console is the only production
caller of either.

## Consequences

- An order cannot become `paid`, be emailed as paid, or count as revenue without its gateway's
  confirmation. Supporting an offline method later is one line in the declaration, plus that
  method.
- The admin surface can no longer move an order to `paid` at all. Client-contract cases that need
  a paid order arrange one through the settlement (`arrange.settle`).
- The `refunded` state now has two meanings: money returned through the ledger (with its email),
  or a refund made outside Otta that the operator recorded (with no email). The Money tab's
  ledger shows which.
- This record leaves Cancel order's handling of a paid order's money unchanged: it neither refunds
  nor restocks. Until that changes, no copy may say that it does.

## Amended 2026-10-02 — cancelling a paid order refunds it and restocks it

This amendment replaces the last Consequence above: Cancel order now refunds and restocks a paid
order, so the copy that said it does not is replaced too. The bare-cancel refusal still stands —
every bare `→ cancelled` is refused — but its paid-order text now says Cancel order "refunds what
the buyer paid and returns the items to stock unless you untick it". The Cancel group's label,
banner and confirm are composed from one `CancelEffects` value (`cancelConfirmText` requires it —
no default, so a paid order can never fall into the pending wording), and the group is rendered
only for an order that can still be cancelled (`pending`, `paid`, `processing`).

QA T1-4: cancelling paid order `bf3b` kept $24 captured, refunded $0 and left the stock
unchanged. Its dialog said the cancel "releases the held stock", and the cancelled email said
nothing about money. Cancel order now settles the money.

**The three legs.** `cancelOrderWithRefund` cancels a `paid` or `processing` order in three legs,
each idempotent on a key derived from the cancellation's:

1. **Refund.** It refunds whatever is still refundable — the ADR-0008 ceiling less earlier
   refunds — through `refundOrder` with `purpose: "cancellation"` and key `<key>:refund`. This is
   the same reserve → issue → finalize ledger every refund uses, not a second money path. A
   `cancellation` row consumes ceiling capacity but never drives `→ refunded`: the cancellation
   closes the order, and `refunded` is terminal.
2. **Restock each physical line exactly once.** The operator can untick **Return the items to
   stock**. A line that still carries its checkout hold needs care. If settle's commit bracket is
   still open, the hold is `adopted`, and the cancel's release intent would return its units
   while the restock returned them again — phantom stock, then oversell. So the bracket is closed
   first with `commit`, which is idempotent and a no-op on a committed hold. That leaves the
   release as a no-op, and the restock (`<key>:restock:<lineId>`) returns the units once. Some
   lines are skipped and reported (`restockSkipped`) instead of restocked:
   - a hold that was already `released` (lost before settlement), whose units went back then;
   - a reservation record that no longer exists, where it cannot be told whether the units were
     taken;
   - a sku with no inventory row.
3. **Cancel through the guarded flip**, recording the refund and the restock on the envelope. The
   cancelled email says "A refund of X is on its way to your original payment method." If the
   order moved but is still cancellable (paid → processing), the flip is retried once from where
   the order now is.

A pending order is cancelled exactly as before: no money moves, and the held stock is released by
the cancel.

**The flip is the commit point.** It comes last. A crash anywhere before it leaves the order
`paid`, where the console still offers Cancel. The retry then replays the refund (recorded ⇒
duplicate; reserved ⇒ resumed under Stripe's native idempotency key) and the restock (spent keys
move nothing), and lands the flip.

**A refund that fails refuses the cancel.** We chose this over cancelling and flagging the order
for a manual refund. It leaves no state where the buyer has been told "cancelled" while the shop
keeps the money; the order stays as the operator found it, with nothing restocked and nobody
emailed.
- A retryable failure is retried by clicking again; the retry continues the same refund.
- A rejected attempt spends its key, so the next attempt uses `<key>:refund:<n>`.
- An unknown outcome is never retried blind.

**Refused up front, with nothing changed:**
- `REFUND_NOT_AUTOMATIC`: money the gateway cannot return automatically (x402, or no gateway
  wired). Recording a manual refund here would claim the operator had already sent it. The
  console points the operator to send the money and record a manual refund in Money → Refunds. A
  later "cancel — refunded outside Otta" option would let such an order be cancelled with its
  units restocked; it is not built yet.
- `REFUND_IN_FLIGHT`: another refund on the order is still reserved or unverified.
- `MULTIPLE_CAPTURES`: the order was paid in more than one capture. One gateway refund targets one
  capture, so the provider would reject the remainder on every attempt. Refunding per capture is a
  follow-up.

**The one state left for a person** is an order that ships between the refund and the flip. The
money is back. The order is flagged with what was refunded, whether units were restocked, and the
next step (contact the buyer, then stop the shipment or Mark refunded). The outcome,
`CANCEL_LOST_AFTER_REFUND`, carries what moved.

**Consequences, accepted:**
- Restocking is the default. A `processing` order may already be picked or packed, so its units
  are not really back on the shelf; the checkbox hint says to untick then.
- Units the merchant already restocked by hand are restocked again unless the box is unticked.
  The hint says this too.
- The manual paths never restock. A refund recorded in Money → Refunds and a Mark refunded both
  leave stock untouched.
- `restocked` on the envelope reflects the restock records this cancellation replayed.
- A cancellation refunds the whole remainder. Partial or line-level cancellation is out of scope.
- **Restock comes before the flip, on purpose** — the flip is the commit point, so a crash
  before it must leave the order paid and retryable. The cost: in the race where the order ships
  between the restock and the flip, units that just shipped are counted back into stock. That
  case is flagged with what was refunded and restocked, and the notice names the state the order
  moved to, so a person corrects the count.
- **An open commit bracket is closed whatever the checkbox says.** A still-`adopted` hold is
  committed on every cancel of a paid order, so the flip's release cannot return its units when
  Return to stock was unticked; only the restock follows the choice.
- **The first attempt's restock choice is kept.** It is stored on the cancellation's refund row,
  so a retry after a crash restocks (or not) as the first attempt did, and the envelope says what
  happened. A cancellation that refunds nothing has no row to carry it; its retry follows the
  checkbox.
- **A failure after the refund is an outcome, not a throw.** If the restock or the flip fails once
  the refund has gone through, the order is flagged ("did not finish") and the console says
  "Refunded X, but the cancel didn't finish — click Cancel order again (it will not refund
  twice)" (`CANCEL_INCOMPLETE_AFTER_REFUND`). A busy store reads "the store was busy" instead.
  The retry that finishes clears that flag (compare-and-clear on the exact flag), so a cancelled
  order never keeps an alert pointing at a control it no longer has. The lost-race flag is
  best-effort the same way: nothing after a refund surfaces as a bare throw.
- A late payment's automatic refund (ADR-0022/0008, `settleOrder`) is recorded with its own
  purpose, `late-payment`. Only a `refund`-purpose row can drive `→ refunded`, so neither a
  cancellation's refund nor a late payment's can flip an order.

## Amended 2026-10-02 — admin writes send their email inline; every refund email states its amount

QA T1-6: admin moves only enqueued their email. The cron sent it up to 15 minutes later, out of
order when several were due, while the console said the buyer had been emailed. A partial refund
sent no email at all.

- **Inline, truthful.** Each admin write that enqueues a buyer email ends with
  `sendOrderEmailsNow` for that order. That covers a status move, a fulfilment, a cancel and a
  refund. It goes through the same order-scoped drain the settle routes use (first attempts only,
  inline timeouts cut short, the cron as backstop) and is bounded by the write's ONE deadline,
  fixed as the write starts (`settle-deadline.ts`) — so a slow refund leaves the email only what
  is left. It is best-effort and never fails the write (ADR-0005's second 2026-10-02 amendment). The write reports `email: sent |
  queued | unconfigured`, decided by whether the row THIS write enqueued was delivered; the
  dispatchers' `onSent` reports which rows went out. The console says "emailed" only for `sent`,
  "queued and will be retried automatically" for `queued` (no time promise — a failed send is
  backed off), and "no email provider" for
  `unconfigured`.
- **Which refunds email the buyer.** An admin refund in its own right (`purpose: "refund"`) that
  leaves money captured emails the buyer with `order-refund-issued`, through a
  `refund-issued` NOTICE row appended in the write that finalizes the refund. That covers a gateway refund and also a MANUAL refund recorded in Money → Refunds,
  because recording one is the operator attesting the money was sent. Its wording is neutral about
  how much and how the money went back ("We've issued a refund for your order"; the amount is on
  its "Refunded" line): the same notice announces a lost-race cancellation's FULL refund, and a
  manual x402 refund goes to a wallet. A refund that reaches the ceiling is announced by the `refunded` email,
  which states Σ refunded. Two things never email: a Mark refunded, because it attests nothing
  and moves no money (Decision 3), and a cancellation's refund, which the cancelled email carries.
  The exception is a cancellation that lost the race to a shipment: no cancelled email will go,
  so its refund announces itself with the same `refund-issued` notice (`enqueueNotice`).
- **One outbox mechanism for every non-state email.** The late-payment refund's notice and the
  admin refund's are the same kind of row (`OutboxEmail.notice`): one rule keeps them out of the
  per-state first-wins lookup, one render path states "Refunded: X" for every refund email (the
  `refunded` state email gets the ledger's Σ), and the dedupe key is (orderId, kind, refundId) —
  so each refund announces itself once, and a late payment's notice now carries its refund id.
  A late-payment refund has its own purpose (`late-payment`) and sends only its notice: exactly
  one email, pinned in the late-payment contract.
  A notice entry stored before refund ids existed (no `refundId`) matches any refund of its
  kind, so a late-payment replay after deploy does not email twice.
- **The lost race's email goes inline too.** When a cancellation loses the race to a shipment,
  its refund's `refund-issued` notice is sent inline like any write's email, and the console's
  notice says whether it went.

## Amended 2026-10-03 — Mark refunded only where no captured money is still held

QA round 2 (M4): on a shipped Stripe order with $10.00 captured and $3.50 refunded, Mark
refunded closed the order as `refunded`. The buyer's order page then said "refunded" while the
shop still held $6.50. Decision 3 kept Mark refunded as "the only way to close an order whose
refund was made outside Otta"; it did not ask whether the money was in fact outside Otta.

**The rule.** `transitionOrderAsAdmin` refuses `→ refunded` with `REFUND_THROUGH_MONEY`, and
`adminNextStates(order, ledger)` does not offer it, unless `markRefundedAllowed` holds, decided
from the refund ledger:

1. **The method returns money outside Otta.** A per-method declaration, like the settlement
   one: Stripe is `provider`, x402 is `outside` (it cannot refund automatically; the operator
   sends the money). For an `outside` method, Mark refunded is what records that.
2. **Nothing is left to refund through the provider.** `unrefundedCapturedCents` = succeeded
   payments less RECORDED refunds. A reserved or unverified refund is a promise, not money back
   (an unverified full refund may still void), so it does not count.
3. **The provider itself reported the payment refunded in full.** When a refund's pre-flight
   answers `PROVIDER_ALREADY_REFUNDED`, the Stripe adapter now returns its own figures (refunded,
   captured). Refunded in full ⇒ `refundOrder` flags the order with `PROVIDER_REFUNDED_FLAG_PREFIX`,
   and that flag unlocks Mark refunded. Refunded in part (the pre-flight also refuses an amount
   that would over-run a partial dashboard refund) ⇒ an informational flag naming both amounts
   ("partially refunded at the provider: 3.50 USD of 10.00 USD") that unlocks nothing. No figures
   ⇒ no flag: unknown is not refunded. A flag is never written over an open one, except the
   provider's own earlier answer. The unlocking flag tells the operator to mark the order refunded
   BEFORE resolving the flag, because resolving it removes the permission.

**Never while a refund is unresolved.** Whatever the above, `→ refunded` is refused with
`REFUND_IN_FLIGHT` (and not offered) while any refund on the order is reserved or unverified —
its outcome decides whether money is still held. This is the cancel path's rule.

Otherwise the operator is sent to Money → Refunds, which returns the money and emails the buyer.
The refusal copy says what to do about a dashboard refund.

**Who made a move.** `transitionOrderAsAdmin` takes an `actor`, recorded on the flip's audit
event. The console passes the signed-in operator the host names on the private admin route
(`routeCtx.user`: display name, else email). Refunds and cancels with no typed name are recorded
by the same operator rather than "admin". History shows them, and it now also lists each refund
on the ledger and what a cancellation refunded and restocked.

**The pricing-error reason stays private.** QA asked for a Reason line on the "Pricing error"
cancel email; the earlier review's decision stands (it invites disputes over the merchant's
mistake). The email reads as the plain cancellation, with no Reason line, as before.

**An unverified refund is resolved by a person.** A refund whose provider call timed out is
held `unverified`: it keeps its ceiling capacity until someone checks the provider. Nothing else
ever settled it — a same-key retry answers `GATEWAY_UNVERIFIED` without calling the provider, no
webhook finalizes it, and Mark refunded and cancel-with-refund both refuse `REFUND_IN_FLIGHT` —
so the order could never be closed. `resolveUnverifiedRefund` gives the two answers, each behind
a confirm in Money → Refunds and idempotent:

- **Confirmed at the provider** → the row is finalized exactly as the gateway's success would
  be (`finalizeRefund`): recorded with the provider's refund id if the operator has it (else a
  `confirmed-by-operator:` marker), the ceiling flip to `refunded` when it completes the refund,
  and the same one refund email, sent at once.
- **It didn't happen** → `voidUnverifiedRefund`: `unverified → voided`, capacity released; Mark
  refunded stays guarded by the money still held.

Only an `unverified` row can be resolved (a reserved, recorded or voided one, or another order's
key, is refused); a replay of the same answer changes nothing; the operator the host names is
recorded on the row (`resolvedBy`). A successful resolve compare-and-clears the order's "never
finalized" flag for that refund (exact text, as cancel-with-refund clears its own) and never any
other flag. A wrong "it didn't happen" cannot pay twice: a new refund's pre-check asks the
provider first and issues nothing if it is already refunded. This closes the earlier follow-up "admin confirms a refund at
the provider". When the refund path's own RESUME finds the provider already showing money on a
reservation, the flag it writes now names the provider's figures and points to this action.

Provider figures in flags are written in the currency's real minor-unit exponent (ICU's table:
JPY 0, USD 2, BHD 3).

**Consequences.**
- A Stripe order with money still held can only reach `refunded` through the ledger, so its
  buyer's page and its "Refunded $X" line agree with the money.
- An order refunded in the dashboard needs one extra step (the Money → Refunds attempt that
  finds it) before it can be closed. A store with an open anomaly flag on that order resolves
  that flag first.
- The admin order read now reads the order's ledger (the same one document) to compute its
  offers.
