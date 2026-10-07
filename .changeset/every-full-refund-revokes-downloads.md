---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Every path that returns an order's money IN FULL now revokes the order's download
entitlements, not only `refundOrder` (issue #376). Each runs the revocation after the
money or state change is recorded, and again on its idempotent replay, so a crash in
between is finished by the retry:

- **Mark refunded** (`transitionOrder`, `transitionOrderAsAdmin` → `refunded`, including
  the replay that is already `refunded`). Mark refunded is only allowed when nothing is
  left for the provider to return, so `refunded` means a full refund.
- **Confirming an unverified refund** (`resolveUnverifiedRefund`, `confirmed`). It revokes
  when the order is now `refunded`, or when the row was a cancellation's refund, which
  is always the whole remainder. A partial confirm or a `voided` answer revokes nothing.
- **Cancel with refund** (`cancelOrderWithRefund`). Its refund leg returns everything
  still refundable, so the revoke runs right after that refund is recorded and before
  the flip. A cancel whose flip is lost or does not finish still revokes. A revoke that
  fails is answered `CANCEL_INCOMPLETE_AFTER_REFUND`, and the retry finishes it without
  a second provider call.
- **A late payment refunded on a dead order** needs no revoke. Such an order never
  reached `paid`, so it was never granted anything; a test pins this.

Each use-case takes an optional `entitlementStore`, and the admin orders client wires
all three.
