# 0001. Plugin + separate commerce service

- Status: accepted
- Date: 2026-07-10

## Context

Urumi is a WooCommerce-equivalent commerce layer for EmDash. The obvious shape — "put
everything in an EmDash plugin" — collides with how EmDash's plugin sandbox works
(verified in source):

- Plugins run in a separate V8 isolate with **no direct database access**. All data goes
  through a capability-scoped RPC bridge; the host runs the SQL and returns JSON copies.
- The bridge exposes **no atomic write, compare-and-set, unique constraint, or cross-call
  transaction** on any backend. `ctx.storage.put` is an unconditional upsert; declared
  `uniqueIndexes` are silently downgraded to plain indexes.

Consequently a sandboxed plugin **cannot** safely decrement stock: read-then-write across
two bridge calls always has an oversell race, and no primitive closes it. Correct commerce
requires a transactional database and at least one atomic operation.

Options considered:

1. **Pure plugin** — impossible to make correct given the constraints above.
2. **Cloudflare Durable Object** per SKU as a single-writer authority — works, but
   Cloudflare-locked, adds a stateful actor to operate, and is a foreign model.
3. **Separate host-side service owning a real database** — the plugin calls it over HTTP.

## Decision

Ship Urumi as **two parts**:

1. A **sandbox-clean EmDash plugin** — storefront routes, content-sync hooks, the
   on-screen product-data field widget, cart/checkout orchestration, x402 entitlement
   handling. It holds no money or stock state and reaches the service **only** via
   `ctx.http` (capability `network:request` + `allowedHosts`).
2. A **standalone commerce service** (Node + a real SQL database) that owns all money and
   stock truth and performs the atomic inventory operation as a single statement:
   `UPDATE inventory SET on_hand = on_hand - :q WHERE sku = :s AND on_hand >= :q RETURNING`
   (atomic on SQLite, Postgres, and D1 — chosen so it needs no `FOR UPDATE` or interactive
   transaction).

## Consequences

- **Correctness:** oversell is structurally impossible; the atomic decrement lives where
  atomicity exists.
- **Portability:** the plugin stays sandbox-clean and works on Node (workerd sidecar) and
  Cloudflare (Dynamic Workers) alike; egress works in both sandboxes. It also sidesteps the
  EmDash constraint that sandboxed plugins are D1-only — commerce never touches EmDash's DB.
- **Not a pure plugin.** Installing Urumi means running a companion service. Accepted
  tradeoff; it is the price of correctness under the sandbox model.
- **Boundary discipline:** the plugin↔service contract is HTTP only. No shared DB, no
  shared process. This is enforced by the sandbox, not just convention.
- Supersedes considering a Durable Object; a DO may still be revisited only if a future
  requirement needs per-SKU coordination beyond what a single SQL statement provides.
