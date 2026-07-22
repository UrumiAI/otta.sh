---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
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
  once-only replay case — green against the in-memory fake first.
- **Adapters (`[Adapters]`).** `KyselyOrderNotesStore` over better-sqlite3 + pg, green against
  the contract suite. Forward-only migration `0010_order_notes` (guarded by `idempotency_key`
  UNIQUE; `(order_id, created_at, id)` index = the list order). The concurrent-replay race —
  N concurrent appends with one key land exactly one row — runs **against Postgres**.
- **Service (`[Service]`).** `GET`/`POST /admin/orders/:orderId/notes` mirroring the port 1:1:
  the GET is internal-token guarded (read); the POST is additionally covered by the
  `X-Service-Token` write gate (any non-GET). The client-side behavior runs over HTTP against a
  live Postgres-backed server (append, chronological list, idempotent replay, validation → 400,
  unknown order → 404, auth + write-gate guards).
- **Plugin (`[Plugin]`).** The Block Kit order-detail page gains a Notes section: a display-only
  notes table (append order) + an add-note form, threading the admin + service tokens like the
  transition action. Stays sandbox-clean (blocks from the local mirror only; service reached
  only via `ctx.http` + `allowedHosts`), verified under the workerd-on-Node sandbox.
