---
"@otta-sh/plugin": minor
---

`storefront/cart/create` can replace a SPENT cart: it takes an optional `replacesCartId`
(the cookie's cart, checked out into a finished order), and `CommerceClient.replaceCart
(spentCartId)` backs it. The plugin checks the cart exists, is checked out, and that its
order is no longer pending — the storefront's own rule, enforced where it cannot be
skipped — and derives the idempotency key itself (`rotate:<cartId>`), so the same spent
cart always gets the same replacement (and cookie) and racing requests converge. A caller
never chooses a key; cart ids are bearer secrets, so a spent cart's id grants access to
the cart that replaces it. New refusals on `CartCreateRouteResult`: `INVALID_INPUT` for a
malformed `replacesCartId`, `CART_NOT_FOUND`, `CART_NOT_CHECKED_OUT`, and
`ORDER_NOT_FINISHED` (`ReplaceCartResult`).

**BREAKING** for an out-of-tree `CommerceClient` implementation: `replaceCart` is a new
required method.
