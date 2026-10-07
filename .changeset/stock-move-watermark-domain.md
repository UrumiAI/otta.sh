---
"@otta-sh/domain": minor
---

`InventoryStore.removeStock` (and the `removeStock` use-case) take an optional fourth
argument, `{ expectedOnHand }`: the on-hand the removal was decided against. When present,
the removal applies only if the live count still equals it, judged in the same write as the
decrement and before its `onHand >= qty` guard. Otherwise it answers the new terminal result
`{ ok: false, reason: "STALE_ON_HAND", onHand }`, which moves nothing and consumes the key
like `INSUFFICIENT_STOCK`. The ledger answers first, so a retry of an applied key still
echoes its success after the count has moved.

A key reused under a different watermark, or recorded with one and replayed without, is a
`StockMovementMismatchError`. A key recorded WITHOUT a watermark (a claim from before this
release) is honoured whatever the replay carries.

`restock` is unchanged and takes no watermark: `onHand` is the available count, which every
sale moves, and an add is commutative.

Both `RestockResult` and `StockRemovalResult`'s success member gains an optional
`replayed: true` (exported as `StockMovementApplied`). It is present exactly when the
answer came from the idempotency ledger, meaning an earlier call with the key moved the
units and this one moved nothing, so a caller can report "already applied" rather than a
fresh movement. It is never stored, and a replayed refusal carries no flag.

**Results can now carry `replayed: true`, so a `toEqual` comparison of a replayed result
against the first-hand one changes.**

Additive for callers that omit the option. `StockRemovalResult` gains the `STALE_ON_HAND`
member (exported as `StaleOnHandResult`), so an exhaustive switch over it needs a new case.
`assertStockMovementOptions` is exported for adapters.
