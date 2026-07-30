---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
---

Batch the per-line checkout ADOPT and settle COMMIT into single guarded UPDATE
statements (PR B — checkout-write batching), preserving the reservation
state-machine semantics and anomaly detection byte-for-byte.

- **`@otta-sh/domain`**: adds two REQUIRED `InventoryStore` port methods,
  `adoptMany(input)` and `commitMany(reservationIds)`, alongside the singular
  `adopt`/`commit` (which remain — still used by inventory use-cases and the
  gateway harness). This is an **additive-but-technically-breaking** port change:
  every `InventoryStore` implementation must now supply the two batch methods
  (pre-1.0 minor per DEVELOPMENT.md §6). `adoptMany` folds one order's physical
  `held → adopted` flips into a single guarded `UPDATE … WHERE id IN (:ids) AND
  state='held' AND expires_at > :now` plus one classification `SELECT` over the
  misses; its per-id semantics are `adopt`'s byte-for-byte (an already-adopted
  row for THIS order is an idempotent replay folded into `adopted` WITHOUT an
  `expires_at` re-check; every other missing id — incl. unknown — is
  `RESERVATION_LOST`). `commitMany` folds a paid order's `held|adopted →
  committed` flips into one guarded order-UNSCOPED `UPDATE`; an already-committed
  id is benign, a released/failed id is a LOST hold, and an UNKNOWN id THROWS
  (matching singular `commit`'s `#selectById`). `createOrderFromCart` now adopts
  via one `adoptMany`; `settleOrder` commits via one `commitMany`, still
  recording one `COMMIT_LOST` anomaly + reconciliation flag PER lost line (N lost
  ⇒ N anomalies, off the same stale flag read). The `InMemoryInventoryStore` fake
  is the contract oracle: `adoptMany` accumulates over singular `adopt`;
  `commitMany` catches `ReservationCommitLostError` per id → `lost` and continues.
  The digital `entitlement.grant` loop and the release path are untouched.

- **`@otta-sh/store-postgres`**: implements `adoptMany`/`commitMany` on
  `KyselyInventoryStore` as the single guarded UPDATE + classification SELECT
  described above (empty-ids short-circuit; `IN (:ids)`, never `= ANY`).

The contract suite gains adoptMany/commitMany cases (all-success, partial
released/committed/expired, idempotent replay incl. adopted-past-deadline, empty,
and commitMany unknown-id-throws), run against the fake, SQLite, and Postgres. A
new Postgres-required multi-line no-oversell test races carts with 2–3
distinct-sku physical lines and proves the batch never oversells or half-commits
(committed == fullWinners × linesPerOrder, each sku on_hand == 0).
