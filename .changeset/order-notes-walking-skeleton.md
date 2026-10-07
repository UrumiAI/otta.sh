---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Order notes — the admin-UX walking skeleton (Increment 0): an append-only merchant
annotation on an order, wired end-to-end through every layer as the pattern later slices copy.

Notes carry `{author, body, createdAt}` on an order's mutable envelope — never a line item or
price, so the order snapshot invariant is untouched. Append-only: no edit/delete surface in
this slice. Every append carries an `idempotencyKey`; the store enforces once-only.

- **Domain (`[Domain]`).** New `OrderNotesStore` port (`append` / `listForOrder`) + the pure
  `appendOrderNote` / `listOrderNotes` use-cases (validate + trim author/body, reject a note on
  a non-existent order). Behavioral contract suite `orderNotesStoreContract` is the spec —
  append, chronological append order (`created_at ASC, id ASC`), per-order scoping, and the
  once-only replay case, including the concurrent race where N concurrent appends carrying one
  key land exactly one row — green against the in-memory fake first.
- **Plugin (`[Plugin]`).** The Block Kit order-detail page gains a Notes section: a display-only
  notes table (append order) + an add-note form, following the transition action's pattern.
  Stays sandbox-clean (blocks from the local mirror only), verified under the workerd-on-Node
  sandbox.
