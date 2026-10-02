---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": patch
---

Admin status moves can no longer claim money that did not move (QA T1-3, T1-4, T1-6;
ADR-0026).

- **`@otta-sh/domain`.** New use-case `transitionOrderAsAdmin`: `transitionOrder` plus three
  rules for a move made by hand.
  - `pending → paid` is refused with `MANUAL_PAYMENT_NOT_ALLOWED` unless the payment method is
    declared offline. None is today, so the rule fails closed: Stripe, x402, and an order with
    no method on file are all refused (`manualPaymentAllowed`).
  - Every bare `→ cancelled` is refused with `USE_CANCEL`: it would record no reason and release
    no stock hold. Cancel order is the one way to cancel; it does not refund a paid order.
  - `→ refunded` moves the state and enqueues no email, because a manual Mark refunded records a
    refund made outside Otta.

  `adminNextStates(order)` is the matching offer, and `TransitionOrderAsAdminFailure` names its
  refusals. `transitionOrder` and `transitionOrderAsAdmin` share one precheck.
- **`@otta-sh/plugin`.** The Orders console offers `adminNextStates` and runs every transition
  through `transitionOrderAsAdmin`. A refused move answers `409` with `reason`
  (`TransitionOrderResult`'s failure arm gains an optional `reason`, typed as `TransitionRefusal`),
  and the console shows its own notice for each. A Mark refunded that applied says "No money moved
  and the buyer was not emailed."
- **`@otta-sh/admin-presentation`.** The Mark refunded confirm says the move does not move money
  and does not email the buyer.
