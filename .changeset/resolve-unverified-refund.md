---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-react": minor
---

An `unverified` refund (its provider call timed out) can now be resolved by a person, so the
order can be closed (review round 2). `resolveUnverifiedRefund` answers it either way:
"Confirmed at the provider" finalizes it as the gateway's success would (recorded, the ceiling
flip to `refunded`, the refund email once; the provider refund id is optional), "It didn't
happen" voids it and releases its capacity (`OrderStore.voidUnverifiedRefund`, new; both stores).
Only an unverified row can be resolved, a replay changes nothing, and the operator is recorded
on the row (`RefundRecord.resolvedBy`). The console offers both answers on the row in Money →
Refunds, each behind a confirm (`orders:resolve-refund-confirmed` / `-voided`).

Also: provider figures in reconciliation flags use the currency's real minor-unit exponent
(JPY "1500 JPY"); the resume path's flag names the provider's figures; the provider-refunded
notices say an already-open flag is kept and to resolve it and try again.
