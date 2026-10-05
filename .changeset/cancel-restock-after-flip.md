---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
---

Cancelling a paid order restocks only after the cancel lands (issue #364; ADR-0026's
2026-10-05 amendment). Before, the restock ran first, so an order that shipped between the
restock and the cancel (or a cancel that failed) had its shipped units counted back into stock.

- **`@otta-sh/domain`.** `cancelOrderWithRefund` closes the commit brackets, flips, then
  restocks. The flip records the restock it owes on the cancellation
  (`OrderCancellation.restockPending: { idempotencyKey, lineIds }`), and the restock clears it.
  The success outcome gains `restockPending: boolean`: true when the order is cancelled but the
  restock after the flip failed. `CANCEL_LOST_AFTER_REFUND` now always reports
  `restockedUnits: 0`. New `finishCancellationRestock(deps, orderId)` finishes a pending restock
  exactly once under the recorded keys; a replay of `cancelOrderWithRefund` runs it too.
  **Port change:** `OrderStore` gains `completeCancellationRestock(input)`, and `CancelOrderInput`
  gains an optional `restockPending`. Custom `OrderStore` implementations must add the method.
- **`@otta-sh/store-emdash`.** Persists `restockPending` on the cancellation (omitted when
  nothing is owed) and counts it in `holdsPendingAt`, so the sweep finds the order.
  `completeCancellationRestock` is a compare-and-set guarded on the marker's key.
- **`@otta-sh/plugin`.** The cron's `hold-intents` leg finishes pending cancellation restocks.
  The cancel notice says "The items are not back in stock yet; Otta will return them
  automatically." when the restock is still pending, and the cancel result carries
  `restockPending: true` then.
- **A stuck restock is flagged.** After `CANCELLATION_RESTOCK_FLAG_AFTER` (3) consecutive failed
  sweep attempts the order is flagged once ("items could not be returned to stock: <why>"); the
  flag clears itself when the restock lands. `OrderStore` gains
  `recordCancellationRestockFailure(orderId, key)`, and `finishCancellationRestock` now returns
  `failure` instead of throwing.
- **History** shows "restock pending" on the cancellation while the units are still owed
  (`restockPending: true` on the timeline entry), in the React admin too.
- **Review round 1.** Every path that finishes a pending restock (the cancel, a replay, the sweep)
  clears the stuck-restock flag, resolved with the new `ReconciliationOutcome` `"restocked"`
  (Otta's own; operators are not offered it). Once flagged, a stuck restock backs off
  (`restockPending.retryAt`; 5 min doubling to 6 h, `cancellationRestockBackoffMs`) so newer work
  is not starved; `recordCancellationRestockFailure` takes `{ retryAfterMs }`. Neither restock
  flag is written over another flag (reported as a sweep anomaly instead). A restock that fails
  part-way reports the units that came back, and the console says "N items returned to stock so
  far; the rest …".
