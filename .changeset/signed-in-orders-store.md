---
"@otta-sh/store-emdash": minor
---

`EmdashOrderStore` follows the domain's order-ownership changes: `createFromCart` persists
`CreateOrderInput.customerId` on a fresh insert (and keys the order's `customerKey` on it,
so the customer filter finds it at once; a same-key replay returns the original order
untouched), and `listForCustomer` returns newest first (`createdAt DESC`, id tie-break in
code, as the admin list's merge does). No migration: existing orders keep their stored
owner, and the order is a read-time sort.
