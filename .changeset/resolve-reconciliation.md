---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Add a resolve path for an order's manual-reconciliation flag (admin-UX Increment 1,
"Order edit" slice 1).

`settleOrder` sets `orders.reconciliation_flag` when a paid order hits a settlement
anomaly it cannot auto-resolve (a lost committed hold, a lost `pending→paid` flip, a
verified success on a terminal order). That flag was **write-only** — nothing cleared it.
This slice completes the reconciliation model with a resolve action that records the
admin's disposition and clears the flag.

- **Domain (`[Domain]`).** New `OrderStore.resolveReconciliation` port method — a **guarded
  flip** (`WHERE reconciliation_flag IS NOT NULL`) that clears the flag and records
  `{outcome, reason, resolvedBy, resolvedAt}` atomically, and the pure `resolveReconciliation`
  use-case. The reconciliation dimension is a two-state machine (`flagged → resolved`)
  ORTHOGONAL to the order state machine: resolving never touches `order.state`, line items,
  or totals (the snapshot invariant). `outcome ∈ {refunded, fulfilled, written_off}` RECORDS
  the disposition — an actual refund/cancel stays the separate `transitionOrder` command.
  Resolving a never-flagged order is `NOT_IN_RECONCILIATION`; an already-resolved order is a
  benign idempotent no-op (mirrors `transitionOrder`'s already-at-target no-op).
- **Adapters (`[Adapters]`).** Forward-only migration `0011` adds four nullable
  `reconciliation_*` columns; the Kysely adapter implements the guarded flip and hydrates the
  resolution. Green against the shared `orderStoreContract` on better-sqlite3 and Postgres,
  plus a Postgres race test: N concurrent resolves on one flagged order yield exactly one
  winner and write the disposition exactly once.
- **Service (`[Service]`).** `POST /admin/orders/:id/resolve-reconciliation` mirrors the port
  1:1, under the internal-token + `X-Service-Token` write gate; the order wire gains
  `reconciliationResolution`.
- **Plugin (`[Plugin]`).** The order detail page surfaces an open flag with an alert banner +
  a resolve form (outcome/reason/resolvedBy), shows the recorded disposition once resolved,
  and threads the tokens via `readAdminTokens`. Sandbox-clean.
