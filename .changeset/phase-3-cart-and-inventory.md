---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
---

Phase 3 — cart + inventory (service-side; plugin/storefront deferred to Wave 3).

- `@urumi/domain`: additive `InventoryStore.adjust(reservationId, newQty, key)`
  (delta reserve / partial release, idempotent by absolute `newQty`, leaving
  `reserve/commit/release` byte-for-byte); a new `CartStore` port and IO-free
  cart use-cases (create/get with lazy-on-read expiry, add, delta update,
  remove, and the `expireHolds` sweep) orchestrating `CartStore` +
  `InventoryStore` + `Clock` with no cross-store transaction; the reusable
  `cartStoreContract`, plus fence guards (`LINE_CHECKED_OUT` /
  `CART_CHECKED_OUT`) and reserve↔cart-line crash-window healing. Cart lines
  snapshot no price (an order invariant, Phase 4).
- `@urumi/store-postgres`: forward-only migration `0003_cart` (`carts`,
  `cart_lines` with `UNIQUE(cart_id, sku)` and nullable `reservation_id`/
  `expires_at`, the dedicated `cart_mutations` idempotency ledger, and an ALTER
  adding nullable `expires_at` to `reservations`); a Kysely `CartStore` whose
  mutations co-locate the line write, reservation-deadline stamp, and ledger
  entry per connection, with a guarded-flip expiry sweep. Green on better-sqlite3
  and pg, including the **no-oversell-through-cart** Postgres acceptance gate.
- `@urumi/service`: cart REST endpoints (`POST /carts`, `GET /carts/:id`,
  `POST/PATCH/DELETE /carts/:id/lines[/:lineId]`) mirroring the use-cases 1:1
  with `Idempotency-Key` → domain key and `OUT_OF_STOCK` as a typed 200 body,
  plus the internal `POST /internal/expire-holds` sweep trigger and a self-
  scheduled Node sweep interval.
