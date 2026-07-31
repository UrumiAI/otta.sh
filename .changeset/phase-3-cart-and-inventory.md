---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
---

Phase 3 — cart + inventory (service-side; plugin/storefront deferred to Wave 3).

- `@otta-sh/domain`: additive `InventoryStore.adjust(reservationId, newQty, key)`
  (delta reserve / partial release) — **exactly-once, ledger-first**: the key is
  claimed before any movement, a stale replay returns the recorded result (ok or
  OUT_OF_STOCK) and moves nothing, and a hold that left `held` throws the typed
  `ReservationNotHeldError`; `reserve/commit/release` stay byte-for-byte. A new
  `CartStore` port (claim/complete `cart_mutations` ledger, guarded `expireHold`
  flip) and IO-free cart use-cases (create/get with lazy-on-read expiry, add,
  delta update, remove, and the `expireHolds` sweep) orchestrating `CartStore` +
  `InventoryStore` + `Clock` with no cross-store transaction; the reusable
  `cartStoreContract`, fence guards (`LINE_CHECKED_OUT` / `CART_CHECKED_OUT`),
  and reserve↔cart-line + remove crash-window healing — including the
  "visible line ⟺ live hold" attach guard: a late add replay whose crashed hold
  the sweep already reaped returns a typed `HOLD_EXPIRED` (409 over HTTP)
  instead of resurrecting a line over dead stock, and a mis-keyed adjust replay
  against the wrong reservation is a typed rejection. Cart lines snapshot no
  price (an order invariant, Phase 4).
- `@otta-sh/store-postgres`: forward-only migration `0003_cart` (`carts`,
  `cart_lines` with `UNIQUE(cart_id, sku)` and nullable `reservation_id`/
  `expires_at`, the claim/complete `cart_mutations` idempotency ledger, the
  `inventory_adjustments` per-mutation claim ledger, and an ALTER adding
  nullable `expires_at` to `reservations`); `KyselyInventoryStore.adjust` as a
  claim + guarded-CAS + movement single transaction (exactly-once under real
  concurrency); a Kysely `CartStore` whose expiry is the guarded `held →
  released` flip that re-checks the deadline atomically (a TTL-reset hold is
  never reaped; raw non-cart reserves are never swept). Green on better-sqlite3
  and pg, including the **no-oversell-through-cart** Postgres acceptance gate
  and same-key/different-key adjust races. `migrateToLatest` accepts
  `migrationTableSchema` so schema-isolated test databases don't collide on the
  Migrator's bookkeeping tables.
- `@otta-sh/service`: cart REST endpoints (`POST /carts`, `GET /carts/:id`,
  `POST/PATCH/DELETE /carts/:id/lines[/:lineId]`) mirroring the use-cases 1:1
  with `Idempotency-Key` → domain key and `OUT_OF_STOCK` as a typed 200 body;
  the internal `POST /internal/expire-holds` sweep trigger guarded by an
  `X-Internal-Token` shared secret compared in constant time
  (`INTERNAL_API_TOKEN`; unset ⇒ 503 disabled);
  a self-scheduled Node sweep interval; and `CART_HOLD_TTL_MS` for the hold TTL.
