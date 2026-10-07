---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": patch
"@otta-sh/plugin": minor
---

Mark refunded can no longer close an order that still holds captured money, and admin
status moves record who made them (QA round 2, M4 and the History "—").

- **`transitionOrderAsAdmin` refuses `→ refunded` with `REFUND_THROUGH_MONEY`** unless
  `markRefundedAllowed` holds: the method returns money outside Otta (x402), the ledger
  shows nothing left to refund (`unrefundedCapturedCents`: succeeded payments less every
  non-voided refund), or the order carries the provider's own word that the payment was
  already refunded. `adminNextStates(order, ledger)` now takes the ledger and offers
  `refunded` on the same rule, so the console renders no button the domain refuses.
- **The provider's word is kept.** When a refund's pre-flight answers
  `PROVIDER_ALREADY_REFUNDED` (refunded in the provider's dashboard), `refundOrder` flags
  the order for reconciliation with `PROVIDER_REFUNDED_FLAG_PREFIX` — never over an open
  flag. That flag is what lets Mark refunded close the order.
- **Who made a move.** `TransitionOrderCommand.actor` / `OrderTransitionInput.actor` are
  recorded on the flip's audit event (both stores). The admin console passes the
  signed-in operator the host names on the private admin route (`routeCtx.user`, now on
  `SandboxedRouteContext`): status moves record them, and a refund or cancel with no
  typed name is recorded by them rather than "admin".
- `getOrder` (admin) reads the order ledger to compute its offers — the same one
  document read.
