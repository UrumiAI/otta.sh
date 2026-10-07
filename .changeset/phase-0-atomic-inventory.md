---
"@otta-sh/domain": minor
---

Phase 0 — atomic inventory skeleton.

`@otta-sh/domain` exports the reusable `inventoryStoreContract` (and its
`InventoryStoreHarness`/options) from the testing barrel, so every adapter runs
the same behavioral spec against the `InventoryStore` port: the
reserve/commit/release choreography that guarantees no oversell under
concurrency (`held ⟺ a durable decrement`), once-only idempotency with
replay-by-state, and crash-window healing. The contract is written against the
port before any adapter exists, and an adapter is done when it is green.
