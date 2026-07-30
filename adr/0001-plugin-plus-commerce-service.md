# 0001. Plugin + separate commerce service

- Status: accepted
- Date: 2026-07-10

## Context

Otta is a WooCommerce-equivalent commerce layer for EmDash. The obvious shape — "put
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

Ship Otta as **two parts**:

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
- **Not a pure plugin.** Installing Otta means running a companion service. Accepted
  tradeoff; it is the price of correctness under the sandbox model.
- **Boundary discipline:** the plugin↔service contract is HTTP only. No shared DB, no
  shared process. This is enforced by the sandbox, not just convention.
- Supersedes considering a Durable Object; a DO may still be revisited only if a future
  requirement needs per-SKU coordination beyond what a single SQL statement provides.

## Amended 2026-07-29 — the on-screen product-data field widget is gone

The Decision above is unchanged in substance and is deliberately left as written. One
item in its part 1 no longer describes the system: **"the on-screen product-data field
widget"**.

That widget wrote sku, price, currency, stock, kind, tax class and dimensions into a
`commerce` JSON field on the CMS content document, which the sync hooks then projected
into `product_commerce`. Because the admin console writes the same columns directly, the
CMS content became a **second writer**, and any publish reverted whatever the console had
edited — pinned for months as the store contract's `KNOWN GAP (F4)` case.

The widget, its `commerce` seed field and its validator were removed in
["one home per field"](../plans/one-home-per-field.md) PR 1b. Commercial fields now have
exactly one home, `product_commerce`, edited only from the admin's **Pricing & inventory**
page. The CMS owns content — title, description, images, slug — and the sync hooks became
lifecycle-only apart from one permanent projection: `product_commerce.title`, a derived
single-writer cache whose only writer is the content sync, kept because
`createOrderFromCart` needs a title snapshot source and the architecture forbids a
cross-database read.

Nothing else in this record changes: the two-part shape, the sandbox-clean plugin, the
HTTP-only boundary and the atomic single-statement decrement all stand.

## Extended 2026-07-30 — the title projection now has its own record

The block above is left exactly as written on 2026-07-29; this one only adds a pointer it
could not have carried, because the record it points at did not exist yet.

The title projection it describes — `product_commerce.title`, a derived single-writer cache
fed by the content sync — is now a decision in its own right:
**[ADR-0013](./0013-product-title-is-cms-owned.md)**, landed by "one home per field" PR 1c
together with the removal of the admin console's Title input. ADR-0013 carries what this
block does not: why dropping the column was considered and rejected (a capability spike
against real workerd and EmDash's real bridge), what would change that decision, and the
costs accepted — including the one genuine regression, a collection whose title field is not
named `title`.

Read together: this record says commercial fields have one home; ADR-0013 says the same of
the title, in the other direction.
