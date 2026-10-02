---
"@otta-sh/store-emdash": patch
---

`EmdashCartStore.abandonClaim` marks an `add` claim decided `OUT_OF_STOCK` as
`abandoned` and recomputes the cart's `holdExpiresAt` in the same
compare-and-set. Before, such a claim pinned an active cart's sweep deadline at
its past `claimedAt`, so the expiry sweep listed that cart and re-read its
reserve key on every tick, for good. Completed and already-abandoned records are
left alone, and a same-key replay still answers `OUT_OF_STOCK`.
