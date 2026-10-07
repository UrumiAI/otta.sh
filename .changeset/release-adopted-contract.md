---
"@otta-sh/domain": patch
---

The shared `inventoryStoreContract` now pins the singular `InventoryStore.releaseAdopted`
on its own (#380). `createOrderFromCart` calls it directly — a lost-hold abandonment, and
an order observed expired/cancelled/failed underneath a checkout — but the suite only ever
reached it as a replay inside the `releaseAdoptedMany` case. Four new cases, run by every
adapter that runs the contract:

- **Happy path and replay:** the order's adopted hold flips to `released` and its units
  return exactly once, to its own SKU; a second and third call move nothing; same-order
  siblings it did not name stay adopted.
- **Not deadline-scoped:** an order past the hold deadline its holds were re-pointed to
  still releases them, which is the expiry path's whole premise.
- **Order-scoped:** another order's adopted hold is skipped silently and stays that
  order's to release.
- **Everything else is left alone:** a committed hold, a still cart-`held` hold and an
  unknown id are silent no-ops that move no stock and change no state.

Test-only: no port, adapter or behaviour change.
