---
"@otta-sh/store-emdash": minor
---

Add `EmdashCartStore` — the domain's `CartStore` over EmDash plugin storage, on
one aggregate document per cart.

The cart is the first commerce aggregate whose invariants cross into another one,
so every mutation that touches stock is written as an explicit bracket: an intent
claim in the cart document's embedded mutation ledger, the inventory movement
through `InventoryStore`, then a completion that lands the line and the ledger
entry in the same conditional write. Hold expiry is the same shape with a
once-only token, so a partial expiry is completable by any replayer and stock
returns exactly once. The ledger is bounded, and the bound never prunes a
claimed-but-incomplete record.

The attach guard is a guarded WRITE, as the port's contract requires: the hold's
deadline is stamped by a new adapter-local capability,
`HoldDeadlineStamper.stampHoldDeadline`, which `EmdashInventoryStore` implements as
one compare-and-set scoped to `state === "held"`. `EmdashCartStore` takes
`InventoryStore & HoldDeadlineStamper` and calls it before each cart write, turning
a refusal into the port's `HoldExpiredError`. That keeps `adopt`/`adoptMany`'s
`expiresAt > now` scope satisfied for every cart hold, and closes the window a read
would have left open. The stamp also refuses a reservation that has gone terminal but
whose hold is not yet pruned, so a line can never attach to spent units.
`adjustLine`, whose line already references its hold, ignores a refusal rather than
throwing: the port documents `HoldExpiredError` as `upsertLine`'s failure.

Also types the inventory store's `release` refusal on a non-live hold: the bare
`Error` becomes `ReservationNotReleasableError`, with the same message, so a caller
that must classify it (the cart expiry does) no longer has to match on text.
