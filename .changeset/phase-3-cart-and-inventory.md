---
"@otta-sh/domain": minor
---

Phase 3 — cart + inventory (domain-side; plugin/storefront deferred to Wave 3).

Additive `InventoryStore.adjust(reservationId, newQty, key)`
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
the sweep already reaped returns a typed `HOLD_EXPIRED`
instead of resurrecting a line over dead stock, and a mis-keyed adjust replay
against the wrong reservation is a typed rejection. Cart lines snapshot no
price (an order invariant, Phase 4).
