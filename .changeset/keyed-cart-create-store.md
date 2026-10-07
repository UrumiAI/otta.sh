---
"@otta-sh/store-emdash": minor
---

`EmdashCartStore.create(currency, key?)` honours the domain's optional create key: it
claims `cart_create_keys/{key}` (create-if-absent) before writing the cart, a losing
racer reads the winner's id back, and every caller create-if-absents the cart document,
so concurrent keyed creates converge on one active cart. **New collection
`cart_create_keys`** in `CART_COLLECTIONS` (no indexes; every access is by id) — the
plugin's storage declaration picks it up from there. It grows by one document per
replaced cart and is never pruned (recorded in ADR-0019's 2026-10-02 amendment). No
migration.
