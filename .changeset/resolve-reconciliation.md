---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Add a resolve path for an order's manual-reconciliation flag (admin-UX Increment 1,
"Order edit" slice 1).

`settleOrder` sets `orders.reconciliation_flag` when a paid order hits a settlement
anomaly it cannot auto-resolve (a lost committed hold, a lost `pending→paid` flip, a
verified success on a terminal order). That flag was **write-only** — nothing cleared it.
This slice completes the reconciliation model with a resolve action that records the
admin's disposition and clears the flag.

- **Domain (`[Domain]`).** New `OrderStore.resolveReconciliation` port method — an
  **equality-guarded compare-and-clear** (`WHERE reconciliation_flag = :expectedFlag`,
  following `transition`'s fromState precedent) that clears the flag and records
  `{outcome, reason, resolvedBy, resolvedAt}` atomically, and the pure `resolveReconciliation`
  use-case. The command carries `expectedFlag` — the anomaly detail the admin actually
  reviewed — so a NEW settle anomaly re-flagging the order mid-review is a
  `RECONCILIATION_FLAG_CHANGED` conflict, never a blind clear. The reconciliation dimension
  is a two-state machine (`flagged → resolved`) ORTHOGONAL to the order state machine:
  resolving never touches `order.state`, line items, or totals (the snapshot invariant).
  `outcome ∈ {refunded, fulfilled, written_off}` RECORDS the disposition — it moves no
  money; an actual refund/cancel stays the separate `transitionOrder` command. Resolving a
  never-flagged order is `NOT_IN_RECONCILIATION`; an already-resolved order is a benign
  idempotent no-op (mirrors `transitionOrder`'s already-at-target no-op). The recorded
  disposition is hydrated onto the order read as `reconciliationResolution`. Green against
  the shared `orderStoreContract`, including the race where N concurrent resolves on one
  flagged order yield exactly one winner and write the disposition exactly once.
- **Plugin (`[Plugin]`).** The order detail page surfaces an open flag with an alert banner +
  a resolve form (outcome/reason/resolvedBy; the displayed flag rides along as
  `expectedFlag`) and shows the recorded disposition once resolved. The outcome copy makes
  explicit that resolving records a disposition and does NOT move money ("refunded (recorded only — issue the refund separately)" + a context
  caption); a stale-review conflict surfaces a dedicated "reconciliation state changed —
  reload" notice. Sandbox-clean.
