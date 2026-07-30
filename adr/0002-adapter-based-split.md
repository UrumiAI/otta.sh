# 0002. Adapter-based split: the plugin↔authority boundary is a deployment choice

- Status: accepted
- Date: 2026-07-10
- Refines: ADR-0001 (does not supersede)

## Context

ADR-0001 splits Urumi into a sandbox-clean plugin and a separate commerce service
because the EmDash plugin sandbox exposes **no atomic/CAS write, no DB-enforced unique
constraint, no cross-call transaction, and no DDL** — verified against source
(`ctx.storage` is a shared `_plugin_storage` JSON document store whose only write is an
unconditional upsert; declared `uniqueIndexes` are downgraded to plain indexes; there is
no `db`/`schema` capability). A sandboxed plugin therefore cannot own inventory / order /
payment truth. See [`../draft-plans/emdash-platform-notes.md`](../draft-plans/emdash-platform-notes.md).

These are **gaps in EmDash's current plugin surface, not permanent laws.** EmDash may
later add a conditional-write / CAS primitive, DB-enforced unique constraints, or
plugin-owned tables. When it does, we want the *option* to collapse the two parts — run
the authority in-process inside the plugin — **without rewriting the commerce logic.** We
do not want the HTTP split baked structurally into the domain.

Two things stay true regardless:

- **For now a separate service is required.** The primitives do not exist today, so the
  two-part design of ADR-0001 is what we build and ship. This is the default, not a
  placeholder.
- **A service may remain preferable even after the primitives land** — payment-secret /
  PCI isolation, stable public webhook URLs, independent scaling, serving non-EmDash
  storefronts, and the fact that a merged-in plugin on Cloudflare pins commerce truth to
  **D1** (sandboxed plugins are D1-only). So the goal is a *cheap, optional* merge, not a
  guaranteed collapse.

## Decision

Build Urumi as a **host-agnostic commerce domain behind two ports**, so the transport
(plugin↔authority) and the storage (domain↔database) are each swappable adapters. The
plugin/service split becomes a **wiring choice per deployment, not a structural
commitment.**

1. **Domain package (`@otta-sh/domain`)** — pure TypeScript commerce logic (inventory
   reserve/commit/release, cart, checkout, orders, pricing, entitlements). **Zero IO
   dependencies:** no `pg`, no `ctx`, no HTTP framework. Depends only on port interfaces.
   This is the artifact that runs in the service today and inside the plugin tomorrow,
   unchanged.

2. **Storage seam** — the domain depends on store interfaces (`InventoryStore`,
   `OrderStore`, …) that express **intent, never SQL**. Atomicity is a *contract* of the
   port ("decrement iff `on_hand ≥ q`, atomically; return success/fail"), not a query.
   Adapters:
   - `PostgresStore` — today.
   - `EmdashStore` — written the day EmDash ships a CAS/unique primitive; satisfies the
     **same contract**.

   Operations stay expressible as the single-statement conditional-`UPDATE … RETURNING`
   pattern (portable across Postgres / SQLite / D1) so they survive onto D1 or a future
   `ctx.storage` CAS.

3. **Transport seam** — storefront routes and the Block Kit widget depend on a
   `CommerceClient` interface, **never on `fetch`**. Adapters:
   - `HttpCommerceClient` — today (calls the service over `ctx.http` + `allowedHosts`).
   - `InProcessCommerceClient` — future (imports `@otta-sh/domain` directly).

   The service's REST API is a **1:1 serialization of the port** and grows no semantics the
   port lacks, so the in-process swap is "call the method instead of POSTing to it."

4. **Idempotency and identity live in the domain** — commands carry an `idempotencyKey`
   and the store enforces once-only (via the future unique constraint); the CMS
   `id = product_id` link key stays stable. These survive the transport swap instead of
   evaporating with the HTTP layer.

5. **Contract tests** — one behavioral suite (notably *no oversell under concurrency*)
   runs against **every** store adapter. A new adapter is "done" when it passes the
   existing suite. Mirrors EmDash's `describeEachDialect` ethos.

**We ship ADR-0001's two-part design now:** `@otta-sh/service` (Node/Worker + Postgres)
wired with `PostgresStore`, and the plugin wired with `HttpCommerceClient`. The seams are
present from day one so the future merge is an adapter, not a migration.

## Consequences

- **Merge-readiness for free.** When EmDash adds the primitives, adopting them = writing
  `EmdashStore` (+ optionally `InProcessCommerceClient`) and passing the existing contract
  tests. Domain, storefront, and widget are untouched.
- **The split becomes a deployment matrix, not a fork.** Same domain code: small store →
  trusted-in-process + D1; serious store → separate service + Postgres. Chosen by which
  adapters are wired.
- **Discipline cost.** The domain must stay IO-free, the HTTP API must mirror the port
  1:1, and idempotency/atomicity must be modelled as domain concepts. Leaking transport
  concerns (status codes as logic, network-only dedupe) or storage concerns (raw SQL in
  the domain, Postgres-only features) re-couples the split and forfeits the payoff.
- **No premature abstraction beyond two ports.** Adapters are added when a second
  implementation actually exists (Postgres now; EmDash later). We do **not** speculatively
  build `EmdashStore` before the primitive ships.
- **A service is still required today** and stays a supported option indefinitely. This
  ADR does not deprecate ADR-0001 — it makes ADR-0001's boundary swappable.
