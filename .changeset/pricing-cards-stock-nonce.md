---
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
---

Fix: the product editor's Pricing & stock cards refused a stock move that repeated an
earlier one (Add 2, Remove 2, Add 2 showed "Nothing changed" on the third). The cards sent
no nonce, so the plugin keyed the move on `productId:direction:onHand:qty`.

- Every Add/Remove click in the cards mints a fresh nonce and sends it with the move. A
  second click in the same moment is ignored rather than sent as a second move.
- When a move's answer is lost (no response, a 5xx, an unreadable reply), the cards re-read
  the count and say which move it was ("Add 5 — the change may have been applied; check the
  count before trying again"), with a **Retry: add 5** button that re-sends that same move
  with the same nonce, whatever quantity is typed now. A new click drops the Retry; Cancel on
  the remove confirm keeps it. It expires 10 minutes after the original loss and is never
  persisted.
- The remove confirm sends the count it showed as the removal's watermark, and its Remove
  button waits while another stock change is still running instead of being dropped. If
  that change moves the count, the confirm closes and says nothing was removed.
- If the re-read after a lost answer fails, the held move and its Retry stay on the
  failure view.
- `products:restock` / `products:remove-stock` results carry `replayed: true` when the move
  was answered from the idempotency ledger, so the cards read "Already applied — now N in
  stock" instead of a fresh "Added N".
