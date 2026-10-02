---
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
---

Fix: the product editor's Pricing & stock cards refused a stock move that repeated an
earlier one (Add 2, Remove 2, Add 2 showed "Nothing changed" on the third). The cards sent
no nonce, so the plugin keyed the move on `productId:direction:onHand:qty`.

- Every Add/Remove click in the cards mints a fresh nonce and sends it with the move. A
  second click in the same moment is ignored rather than sent as a second move.
- When a move's answer is lost (no response, a 5xx, an unreadable reply), the cards say "The
  change may have been applied — check the count before trying again" and offer **Retry this
  change**, which re-sends the same move with the same nonce. A new click drops the Retry;
  Cancel on the remove confirm keeps it. It expires 10 minutes after the original loss and is
  never persisted.
- `products:restock` / `products:remove-stock` results carry `replayed: true` when the move
  was answered from the idempotency ledger, so the cards read "Already applied — now N in
  stock" instead of a fresh "Added N".
