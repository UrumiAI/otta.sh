---
"@urumi/domain": minor
"@urumi/store-postgres": patch
"@urumi/service": minor
---

Typed 404 for `POST /inventory/commit` and `POST /inventory/release` against an
unknown `reservationId` (previously an untyped 500).

At `0.x`, changesets map a **minor** bump to a breaking change (there is no
major to take yet — semver's `0.x` carve-out). The `minor` here IS the
breaking bump, not a feature bump.

- **`@urumi/domain`** — new exported `ReservationNotFoundError` on the
  `InventoryStore` port, thrown from `commit`/`release` (and `commitMany`)
  when `reservationId` was never created — distinct from
  `ReservationCommitLostError`, the existing loud anomaly for a reservation
  that existed but is no longer committable/releasable. The port docblock
  above `commit` documents both, plus a known asymmetry: `adjust` shares the
  same store choke point and throws the same typed error, but nothing at the
  HTTP boundary maps it, so a cart `PATCH /carts/:id/lines/:lineId` against a
  vanished reservation still 500s (deliberate, out of scope — the cart
  failure taxonomy has no "reservation vanished" member).
- **`@urumi/store-postgres`** — the Kysely adapter's `#selectById` choke point
  (reached by `commit`, `release`, `adjust`) and `commitMany`'s unknown-id
  branch now throw `ReservationNotFoundError` instead of a bare `Error`. No
  control-flow change, only a richer type.
- **`@urumi/service`** — `POST /inventory/commit` and `POST /inventory/release`
  now catch `ReservationNotFoundError` and return **404**
  `{ ok: false, reason: "RESERVATION_NOT_FOUND" }` (matching the repo's
  `{ok:false,reason:…}` 404 convention) instead of falling through to the
  generic 500 envelope. Any caller polling for a status code to distinguish
  "unknown reservation" from a DB fault now gets one; a caller that only
  checked `!response.ok` sees no change. `ReservationCommitLostError` keeps
  its existing 500 anomaly semantics — a reservation that existed but was
  lost (released/failed) is still an operational anomaly, not a client error.

**Known follow-up (not in this change):** `release` against a reservation
that exists but is in a non-releasable state still throws an **untyped**
`Error` and 500s (the sibling of `ReservationCommitLostError` that was never
given a type). Typing it, and deciding 409-vs-500, is its own change.
