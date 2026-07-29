---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Give the cart the id of the order it became (issue #132).

Nothing in the system resolved an order from a cart, so `/cart` had no way to
link a buyer to the purchase they had just made. `carts` gains a nullable
`order_id` (migration `0021_cart_order_id`), written by `CartStore.checkout`
and threaded to the wire as `Cart.orderId` / `CartWire.orderId`.

The write is **one statement, two columns**:

```sql
UPDATE carts SET state = 'checked_out', order_id = :orderId
 WHERE id = :cartId AND state = 'active'
```

so the state and the order id are never observable apart, and the existing
`state = 'active'` predicate IS the compare-and-set that makes the stamp
write-once. No new constraint, no `WHERE order_id IS NULL`, no CHECK — the
"`active` ⟺ no order id" invariant is enforced by `checkout` being the column's
single writer, not structurally.

Two things the column deliberately does **not** mean:

- **Not a payment signal.** `cartStore.checkout()` runs before
  `gateway.createIntent()`, so a pending, failed or expired order has a fully
  stamped cart.
- **Not a complete answer to "does an order exist for this cart".** The stamp
  lives only in `finalizeOrder`, and the idempotency short-circuit returns
  before it; a crash between `orderStore.createFromCart` and the flip, or a
  `RESERVATION_LOST` abort, leaves a real `pending` order behind a permanently
  `active`, NULL cart. `orders.cart_id` remains the only complete answer.

`HttpCommerceClient.getCart` normalizes a missing, empty-string or non-string
`orderId` to `null`. Nothing on that path validates the cart body at runtime,
and unlike `state` (which fails safely — `isCartTerminal(undefined)` is false)
`orderId` fails unsafely: `undefined !== null` is true, so an un-normalized
consumer renders `/orders/undefined` as a primary action.

No backfill: the project is unreleased, so there is no production data and
every existing `checked_out` cart predates the writer.

**Security consequence, accepted deliberately.** `GET /carts/:cartId` is
unauthenticated (`app.ts`, `routes/carts.ts`), so emitting `orderId` there makes
a cart id a *permanent* derivation path to an order id — and an order id is not
merely a read token: `GET /entitlements/check` treats a bare `orderId` as an
**open bearer capability** (ADR-0011 precedence rule 2), and
`GET /orders/:orderId` is itself an unauthenticated capability URL. This is
accepted because it grants no new principal: the cart id lives in an
`httpOnly` + `secure` + `sameSite` cookie, so anyone who can call
`GET /carts/:cartId` for a given cart is already the buyer or already holds the
cart id, and both orders reads are redacted (`serializePublicOrder` omits
`buyerRef`, `customerId` and `shippingAddress`), so no PII crosses. The
practical change is one of DURATION, not of audience — the derivation no longer
depends on a short-lived checkout stash. Any future widening of what an order
id alone unlocks must re-examine this route.

At `0.x`, changesets map a **minor** bump to a breaking change (there is no
major to take yet — semver's `0.x` carve-out). The `minor` here IS the breaking
bump, not a feature bump.

**BREAKING:** `CartStore.checkout` now takes a second, required argument —
`checkout(cartId: string, orderId: OrderId)`. `Cart` (`@urumi/domain`) and
`CartWire` (`@urumi/plugin`) both gain a required `orderId: string | null`
field, and `GET /carts/:cartId` now emits `orderId` on the cart body. Any
out-of-tree `CartStore` implementation or `CartWire` literal must be updated.
