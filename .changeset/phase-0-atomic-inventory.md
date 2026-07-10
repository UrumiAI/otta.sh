---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
---

Phase 0 — atomic inventory skeleton.

- `@urumi/domain`: export the reusable `inventoryStoreContract` (and its
  `InventoryStoreHarness`/options) from the testing barrel so every adapter runs
  the same behavioral spec.
- `@urumi/store-postgres`: `KyselyInventoryStore` over better-sqlite3 (local) and
  pg (CI/prod), a forward-only Phase-0 migration (`inventory` + `reservations`
  with `UNIQUE(idempotency_key)`), and the reserve finalize choreography that
  guarantees no oversell under concurrency (`held ⟺ a durable decrement`, with
  replay-by-state and crash-window healing).
- `@urumi/service`: a thin Hono REST API mirroring the inventory port 1:1
  (`POST /inventory/reserve|commit|release`), Zod-validated, `Idempotency-Key`
  header → domain key, no status-code-as-logic.
