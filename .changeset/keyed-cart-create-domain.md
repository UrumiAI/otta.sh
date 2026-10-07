---
"@otta-sh/domain": minor
---

A spent cart can be replaced, once, by a server-derived keyed create.

- **`replaceSpentCart({ ...cartDeps, orderStore }, spentCartId)`**: the replacement for a
  cart checked out into a FINISHED order — `{ ok: true, cartId }`, in the spent cart's
  currency, the SAME cart however often (or concurrently) it is asked for. Refused
  `CART_NOT_FOUND`, `CART_NOT_CHECKED_OUT`, or `ORDER_NOT_FINISHED` (no order, an order
  that cannot be found, or one still `pending` — its payment may still happen). Cart ids
  are bearer secrets: a spent cart's id grants access to the cart that replaces it.
- **`CartStore.create(currency, key?)`** takes an optional idempotency key: the same key
  answers the same cart. Keys are SERVER-DERIVED; `replaceSpentCart` is the only code that
  makes one (`rotate:<spentCartId>`), and the exported `createCart` takes no key. A keyed
  create returns its cart in whatever state it is now — a since-checked-out one heals on
  the next replacement.
- `cartStoreContract` pins the keyed create (including concurrent convergence) and that an
  add refused `CART_CHECKED_OUT` records no mutation under its key.

**BREAKING** for an out-of-tree `CartStore`: `create` must honour the key (an
implementation that ignores it would mint one cart per racing request).
