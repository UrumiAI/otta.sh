---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Give the cart the id of the order it became (issue #132).

Nothing in the system resolved an order from a cart, so `/cart` had no way to
link a buyer to the purchase they had just made. A cart gains a nullable
`orderId`, written by `CartStore.checkout` and carried through as
`Cart.orderId` / `CartWire.orderId`.

The write is **one conditional update over both fields** — the checked-out flag
and the order id move together, so the state and the order id are never
observable apart, and the existing "still active" predicate IS the
compare-and-set that makes the stamp write-once. No new constraint, no
"order id is still null" guard, no CHECK — the "`active` ⟺ no order id"
invariant is enforced by `checkout` being the field's single writer, not
structurally.

Two things the column deliberately does **not** mean:

- **Not a payment signal.** `cartStore.checkout()` runs before
  `gateway.createIntent()`, so a pending, failed or expired order has a fully
  stamped cart.
- **Not a complete answer to "does an order exist for this cart".** The stamp
  lives only in `finalizeOrder`, and the idempotency short-circuit returns
  before it; a crash between `orderStore.createFromCart` and the flip, or a
  `RESERVATION_LOST` abort, leaves a real `pending` order behind a permanently
  `active`, NULL cart. `orders.cart_id` remains the only complete answer.

The cart read normalizes a missing, empty-string or non-string `orderId` to
`null`. Unlike `state` (which fails safely — `isCartTerminal(undefined)` is
false) `orderId` fails unsafely: `undefined !== null` is true, so an
un-normalized consumer renders `/orders/undefined` as a primary action.

No backfill: the project is unreleased, so there is no production data and
every existing `checked_out` cart predates the writer.

**Security consequence, accepted deliberately.** An unauthenticated cart read
that carries `orderId` makes a cart id a *permanent* derivation path to an
order id, and an order id is not merely a read token — the entitlement check
treats a bare `orderId` as an **open bearer capability** (ADR-0011 precedence
rule 2). This is accepted because it grants no new principal: the cart id lives
in an `httpOnly` + `secure` + `sameSite` cookie, so anyone who can read a given
cart is already the buyer or already holds the cart id, and the public order
projection is redacted (`buyerRef`, `customerId` and `shippingAddress` are
omitted), so no PII crosses. The practical change is one of DURATION, not of
audience — the derivation no longer depends on a short-lived checkout stash.
Any future widening of what an order id alone unlocks must re-examine this.

At `0.x`, changesets map a **minor** bump to a breaking change (there is no
major to take yet — semver's `0.x` carve-out). The `minor` here IS the breaking
bump, not a feature bump.

**BREAKING:** `CartStore.checkout` now takes a second, required argument —
`checkout(cartId: string, orderId: OrderId)`. `Cart` (`@otta-sh/domain`) and
`CartWire` (`@otta-sh/plugin`) both gain a required `orderId: string | null`
field, and the cart read now carries `orderId`. Any out-of-tree `CartStore`
implementation or `CartWire` literal must be updated.
