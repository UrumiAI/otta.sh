---
"@otta-sh/domain": minor
---

Typed "reservation not found" on the `InventoryStore` port: committing or
releasing an unknown `reservationId` now raises something a caller can
recognise, where before it was an untyped `Error` indistinguishable from a
store fault.

At `0.x`, changesets map a **minor** bump to a breaking change (there is no
major to take yet — semver's `0.x` carve-out). The `minor` here IS the
breaking bump, not a feature bump.

The new exported `ReservationNotFoundError` is thrown from `commit`/`release`
(and `commitMany`) when `reservationId` was never created — distinct from
`ReservationCommitLostError`, the existing loud anomaly for a reservation that
existed but is no longer committable/releasable. The port docblock above
`commit` documents both, plus a known asymmetry: `adjust` shares the same store
choke point and throws the same typed error, but nothing on the cart path reads
it, so adjusting a cart line against a vanished reservation still surfaces as a
generic fault (deliberate, out of scope — the cart failure taxonomy has no
"reservation vanished" member).

A caller that only asked "did this throw" sees no change; a caller that needs
to tell "unknown reservation" from a store fault now has the type to do it.

**Known follow-up (not in this change):** `release` against a reservation
that exists but is in a non-releasable state still throws an **untyped**
`Error` (the sibling of `ReservationCommitLostError` that was never given a
type). Typing it, and deciding whether it reads as a caller error or an
operational anomaly, is its own change.
