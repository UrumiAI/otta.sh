---
"@otta-sh/plugin": patch
---

An operator's re-click on a refund that is already recorded now finishes it. The orders
console answered that re-click from the refund ledger alone ("Already refunded") without
reaching the service, so if the process had died between recording a FULL refund and
revoking the order's download access, nothing ever ran the revoke. The console now
replays the recorded refund under the key it was recorded with: the service resolves it
as a duplicate with no second provider refund, and revokes the order's downloads when the
order is refunded. The notice is unchanged.
