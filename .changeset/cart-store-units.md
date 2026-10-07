---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

**`CartStore.units(cartId)`**: the cart's state and the sum of its lines' quantities, or
`null` for an unknown cart — from the cart's own record only (no reservation lookups, no
hold expiry, no write). `EmdashCartStore` answers it with one cart-document read; the
in-memory fake implements it too, and the cart-store contract pins that it agrees with
`get()`. For a reader that only counts, such as a storefront header on every page.

**BREAKING** for an out-of-tree `CartStore` implementation: `units` is a new required method.
