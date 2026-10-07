---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

`OrderStore.flagReconciliation(orderId, detail, guard?)` takes an optional
`{ expectedFlag: string | null }` guard and answers whether it wrote. Guarded, it is a
compare-and-set on the flag: written only while the order's live flag still equals
`expectedFlag` (`null` = only while unflagged). Unguarded it is last-writer-wins as before.

The writes that decided from a flag read before a provider call or a commit now use it, so a
flag written in between is never overwritten (issue #364): the refund path's "provider shows
this payment refunded" flag, the intent-cancel sweep's give-up flag, and settlement's
`settle on …`, lost-flip and lost-commit flags.

**BREAKING for out-of-tree stores:** an `OrderStore` must honour the guard and return a
boolean. A store that ignores the guard lets these writes overwrite an anomaly nobody has
reviewed. The new `ReconciliationFlagGuard` type is exported.
