---
"@otta-sh/plugin": minor
"@otta-sh/admin-react": patch
---

Fix: an Add or Remove stock that repeated an earlier move was silently dropped. The
movement's idempotency key was derived from `productId:direction:onHandAtRender:qty`
(F-2a), so Add 2 at 7 → Remove 2 → Add 2 at 7 replayed the first Add and left the count
at 7 under "Added 2", and two tabs that both saw 4 and both added 3 ended at 7.

- **Per-click key, explicit retry.** `products:restock` / `products:remove-stock` accept a
  `nonce`, and the key is built from it. Every Add/Remove click mints a fresh one; a click
  is never taken for a retry because it resembles a lost one.
  - When a stock move's answer is lost, the notice reads "The change may have been applied —
    check the count before trying again" and offers **Retry this change**, the only path
    that re-sends the held nonce.
  - The hold lives in memory only (never in `sessionStorage`, which a duplicated tab copies)
    and is dropped on a Retry click (each sends it once), when a new stock move is
    dispatched (opening a confirm and denying keeps it), when the notice is replaced, and
    10 minutes after the original loss (a Retry lost again does not restart the clock).
  - A present but malformed nonce refuses as unreadable.
- **A replay is reported as one.** The store's `replayed` marker is carried through
  (`StockMoveApplied` on the surface), and the action maps it to "Already applied — This
  change was already applied — stock is now N" with a live re-read, never a fresh "Added N".
- **`Failure.indeterminate`** (admin-react): marks a failure after which the write may
  have run — no response, a 5xx, or an unreadable 2xx.
- **Restock is not pinned.** An add is commutative, so two tabs that each add 3 to 4 end
  at 10, and an honest add is never refused because a shopper checked out meanwhile.
- **A stale removal is a conflict, judged atomically.** The `onHand` the operator saw is
  sent to the store as the domain's `expectedOnHand` and judged with the decrement. A
  removal against a count that has moved answers "Stock changed to N (orders or another
  change) — nothing was removed; check and try again" and moves nothing. The old re-read
  before the write is gone: it ran before the idempotency ledger, so a retry of a removal
  that had landed was told the stock had changed. Checkout traffic can make a removal
  stale, which is accepted.
- **Success reports the count the movement produced.**
- **One release of backward compatibility.** A caller that sends no `nonce` keeps the
  content-derived key, so its double-submit still dedupes. A replayed answer to such a
  submit always reads "This submit changed nothing — an identical earlier change was already applied; if you meant a second change, reload and try again." It is never reported as done. The fallback will be removed, and the nonce
  made mandatory, next release.

**Breaking for exhaustive consumers of `@otta-sh/plugin`'s exported surface:** the
`StockRemovalResult` union gains `{ ok: false, reason: "stale_on_hand", onHand }`, and
`AdminProductsSurface.removeStock` takes an optional `expectedOnHand`. A `switch` over
`StockRemovalResult["reason"]` that handles every member needs a new case. The success
member of both `RestockResult` and `StockRemovalResult` gains an optional `replayed: true`.
