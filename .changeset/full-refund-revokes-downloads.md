---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

A FULL refund now revokes the order's download entitlements; a partial refund does not
(issue #376). "Full" is the ledger's own definition: the order reached `refunded`, which
happens exactly when the finalized refunds reach the ceiling `min(Σ captured, total)`.

`refundOrder` takes an optional `entitlementStore` dependency and, on every `ok` outcome
whose order is `refunded` and has a digital line, calls `revokeByOrder`. That includes the
idempotent same-key replay, which is the crash story: the refund is recorded before the
revocation, so a process that dies between the two is healed by the same-key retry (no
second provider call). A revocation that throws propagates rather than reporting a
success that left access open.

`refundOrder` itself revokes ONLY when the order ends `refunded`. A cancellation's refund
never flips the order to `refunded`, so `refundOrder` does not revoke for it; the cancel
use-case does, once that refund is recorded (see `every-full-refund-revokes-downloads`).
A late payment's refund is on an order that was never paid and never granted anything.

The admin console's refund (`InProcessAdminOrdersClient.refundOrder`) wires the
entitlement store in, so a full refund from the console closes the buyer's download.
