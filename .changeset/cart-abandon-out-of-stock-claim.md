---
"@otta-sh/domain": minor
---

`CartStore` gains `abandonClaim(cartId, key)`, and `addLine` calls it when the
reserve answers `OUT_OF_STOCK` (ADR-0019, amended 2026-10-02).

An add claims its idempotency key before it reserves, so a crash between the two
leaves a marker the hold sweep can follow. An add refused `OUT_OF_STOCK` has no
hold and never will — the reserve key is once-only — yet its claim stayed
outstanding forever, and a store that indexes outstanding claims for its sweep
kept that cart listed and re-read it on every tick.

The claim is now retired, not completed: it reads back `completed: false` (and
the new optional `RecordedCartMutation.abandoned: true`), so a same-key replay
resumes and answers `OUT_OF_STOCK` again. `abandonClaim` is idempotent and a no-op
for an absent key, an unknown cart, or a completed or already-retired record, and
`addLine` calls it best-effort: a failed retirement is logged and the add still
answers `OUT_OF_STOCK`.

One residual: an adapter may bound its retired records (the document store keeps
16 per cart). Once a refused add's record is evicted, a very late replay of its
key runs as a fresh add — on a cart that has since gained a line for that sku, an
increment of that line answered with current truth, the residual an evicted
completed record already has.

**Breaking for a third-party `CartStore`:** the port has a new required method.
The in-memory fake and `@otta-sh/store-emdash` implement it, and
`cartStoreContract` gains cases for it.
