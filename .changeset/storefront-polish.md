---
"@urumi/plugin": minor
---

Storefront/admin polish batch: cart pricing display, friendly errors,
add-to-cart validation, favicon, and an admin Orders duplicate-key fix.

1. **Cart informational pricing** (`storefront/cart/read`): the route now
   batch-loads the cart's distinct line `productId`s through the same
   request-scoped `CommerceBatchLoader` PDP/PLP use (one batch HTTP call per
   render), and returns an additive `pricing` field alongside the untouched
   `cart` (unit price, line subtotal, and a total that sums only priced
   lines). A pricing-lookup failure degrades to `pricing.degraded: true`
   rather than failing the whole cart read — hold/qty/remove keep working.
2. **Bogus SKU / garbage productId rejection** (`sites/staging`'s
   `/cart/add`): a submitted `productId` is now checked against the CMS
   (`getEmDashEntry`) and the live product view model BEFORE the plugin's
   add-line route is ever called, closing a gap where a nonexistent or
   forged productId/sku pair was either silently accepted or misleadingly
   rejected as `OUT_OF_STOCK`.
3. **Admin Orders duplicate React key**: `transitionActions` now returns one
   single-element `actions` block per offered transition state instead of
   one block whose buttons all shared the literal `action_id:
   "orders:transition"` — the collision vendored `ActionsBlockComponent`'s
   `action_id ?? i` React key produced. Known visual tradeoff: the buttons
   now stack vertically instead of rendering inline.
