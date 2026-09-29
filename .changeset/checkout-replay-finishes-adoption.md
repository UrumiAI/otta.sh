---
"@otta-sh/domain": patch
---

A same-key replay of a checkout now FINISHES a checkout that threw after its order
became durable. `createOrderFromCart` inserts the `pending` order before it adopts the
cart's holds and flips the cart; a throw in between (a contended hot-SKU `adoptMany`
raising `StorageContentionError`, a cart flip that blew up) left the holds cart-`held` on
the cart's short deadline behind a still-`active` cart. The client's retry under the same
idempotency key hit the replay short-circuit and got a fresh payment intent without either
step ever running — so the cart sweep or a line removal could return the units to the
shelf under an order the buyer then paid (`COMMIT_LOST` at settle).

- The replay of a `pending` order now re-runs adoption and the cart flip — the same
  post-insert steps as the fresh path, shared through one helper — before re-issuing the
  intent. Both are idempotent for the same order, so replaying a completed checkout is
  unchanged.
- A lost hold (fresh path or replay) now ABANDONS the order at once, exactly as the expiry
  sweep would: `pending → expired` (no email — the buyer is told synchronously), the
  coupon use eagerly freed FIRST, then every hold it adopted released, no payment intent,
  the cart left `active`. Freeing the coupon before the holds means a throw in the hold
  release (a contended hot SKU) can no longer strand it; and any call that observes the
  order `expired` or `failed` (a same-key replay, or the post-adopt re-read) re-frees its
  coupon use idempotently, healing a crash between the flip and the release
  (`expireOrders` only ever looks at `pending` orders). A `cancelled` order keeps its coupon
  use, as `cancelOrder` intends; a `paid` one consumed it. Two concurrent same-key calls
  that both see the lost hold answer differently — the flip winner `RESERVATION_LOST`, the
  loser the expired order with the empty handle — and neither can pay. The call still
  answers `RESERVATION_LOST`; a later same-key place answers the expired order with the
  empty, no-intent handle. Previously the order stayed `pending` until
  its TTL — its adopted siblings off sale for up to 15 minutes — and, the storefront's
  checkout key being fixed per cart, the next place from that cart replayed it into a payable
  intent over the lost hold (`COMMIT_LOST` at settle). A storefront that routes a non-pending
  replay to the order's page (the reference site does) now lands the buyer on the expired
  order, which offers a new cart.
- The cart flipped on replay is the one the order was made from (`order.cartId`).
- After adopting, the order is re-read: if it left `pending` underneath the adoption (a
  settle — which flips `→ paid` before it commits — or an expiry / cancel whose own release
  ran while the holds were still cart-`held`), the call returns that order with the same
  empty, no-intent handle as a replay of a non-pending order, releases whatever it just
  adopted for an expired / cancelled / failed order (never for a paid one), re-frees the coupon
  use of an expired / failed one, and does not stamp the cart. The order is read once more
  immediately before the payment intent is minted, so a concurrent same-key call that
  expires it after that re-read (a double-click whose later clock classed a hold lost) never
  leaves the other call holding a payable intent for the expired order. A paid buyer is never
  told the checkout failed, and a dead order never strands stock. This guard covers the fresh path too.
