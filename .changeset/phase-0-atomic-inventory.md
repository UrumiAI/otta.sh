---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
---

Phase 0 — atomic inventory skeleton.

- `@otta-sh/domain`: export the reusable `inventoryStoreContract` (and its
  `InventoryStoreHarness`/options) from the testing barrel so every adapter runs
  the same behavioral spec.
- `@otta-sh/store-postgres`: `KyselyInventoryStore` over better-sqlite3 (local) and
  pg (CI/prod), a forward-only Phase-0 migration (`inventory` + `reservations`
  with `UNIQUE(idempotency_key)` and a `reservations.sku → inventory.sku` FK
  enforced on both dialects), and the reserve finalize choreography that
  guarantees no oversell under concurrency (`held ⟺ a durable decrement`, with
  replay-by-state and crash-window healing). Also exports a `./testing` subpath
  (`createIsolatedPgSchema`) for per-schema-isolated Postgres tests.
- `@otta-sh/service`: a thin Hono REST API mirroring the inventory port 1:1
  (`POST /inventory/reserve|commit|release`), Zod-validated, `Idempotency-Key`
  header → domain key, no status-code-as-logic, and an `onError` envelope that
  never leaks internal messages/stacks.
