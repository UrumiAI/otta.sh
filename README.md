# Urumi

A commerce layer for [EmDash](https://github.com/emdash-cms/emdash) — the WooCommerce-equivalent for Cloudflare's TypeScript CMS.

## What this is

Urumi turns an EmDash site into a store. It ships as two parts:

1. **Urumi plugin** — a sandbox-clean EmDash plugin: storefront routes, an on-screen
   "Product data" panel (Block Kit field widget), content-sync hooks, cart/checkout
   orchestration, an admin console (catalog, orders, reports, settings), and x402
   gating for digital goods. Talks to the commerce service over HTTP only
   (`network:request` + `allowedHosts`).
2. **Urumi commerce service** — a standalone Node/Hono + Postgres service that owns all
   money and stock truth: catalog, inventory, cart, checkout, orders, customers,
   payments, tax, shipping, discounts, entitlements, reporting, and webhooks.

## Why two parts

**The biggest blocker right now is a missing primitive: EmDash's plugin sandbox has no
atomic write / compare-and-set / transaction.** Plugins run with no direct DB access — all
data crosses a capability-scoped RPC bridge as JSON copies — and `ctx.storage` is an
unconditional upsert whose declared unique indexes are silently downgraded. So a safe
inventory decrement (read-then-write across two bridge calls) always races under
concurrency, and nothing in the plugin surface closes it. Until that primitive exists,
correct commerce needs a transactional database off to the side. The commerce service
holds it and performs the one atomic operation that matters:

```sql
UPDATE inventory SET on_hand = on_hand - :q
 WHERE sku = :s AND on_hand >= :q
RETURNING on_hand;   -- 0 rows = out of stock. No oversell, no lock.
```

## Architecture (summary)

- **Product model = hybrid.** Content (title, description, images, SEO, taxonomies)
  lives in a native EmDash `products` collection; commercial data (price, SKU, stock,
  tax, shipping) lives in the commerce service. Link key = the CMS content `id`.
- **Separate databases.** Commerce Postgres is independent of the EmDash content DB
  (independent scaling; no cross-DB joins — joined in app code at render time).
- **Ports and adapters.** `@urumi/domain` is pure (no IO); every store is a Kysely
  adapter dialect-parameterized over better-sqlite3 (dev) and Postgres (CI/prod). The
  REST API in `@urumi/service` mirrors the domain ports 1:1, and the same client-side
  contract suite runs over the wire so the HTTP format can't drift from the port.
- **Pluggable payments.** Stripe (async webhook) and x402 (HTTP-402 at the page layer)
  behind one `PaymentGateway` interface.
- **Deployment.** Runs on Cloudflare Workers via Hyperdrive over Neon Postgres, with
  cron sweeps for cart/reservation expiry. First-party sites may register the plugin
  trusted (in-process) to stay on the Workers free plan — the plugin still passes the
  full workerd sandbox suite on every CI run, which is the binding contract (ADR-0006).

## Repository layout

| Package | What it is |
|---|---|
| `@urumi/domain` | Pure ports, use-cases, branded money types, contract-test suites. No IO. |
| `@urumi/service` | Thin Hono REST API + Cloudflare Worker entry mirroring the domain ports. |
| `@urumi/store-postgres` | Kysely store adapters (better-sqlite3 local, `pg` CI/prod) + forward-only migrations. |
| `@urumi/payments-stripe` | Stripe `PaymentGateway` adapter (async-webhook, raw-body HMAC). |
| `@urumi/payments-x402` | x402 `PaymentGateway` adapter (synchronous page-gate, facilitator-verified). |
| `@urumi/plugin` | The EmDash plugin: storefront, Block Kit product panel, admin, sync hooks. |
| `sites/staging` | Staging storefront + admin — EmDash on Cloudflare Workers, plugin registered trusted. |

Design decisions live in [`adr/`](./adr/); development practices in
[`DEVELOPMENT.md`](./DEVELOPMENT.md); the agent-facing contract in [`CLAUDE.md`](./CLAUDE.md).

## Development

pnpm workspace · tsdown builds · vitest tests · oxfmt (tabs) · oxlint (type-aware) ·
strict TypeScript.

```bash
pnpm lint         # oxlint + domain-purity dependency check
pnpm typecheck    # tsc -b
pnpm test         # vitest (better-sqlite3 by default)
pnpm format       # oxfmt, tabs
```

The **no-oversell concurrency test is Postgres-required** — better-sqlite3 serializes
writes in one process, so it verifies the SQL is correct, not that it's race-safe. See
`DEVELOPMENT.md` for the TDD / contract-first workflow and commerce invariants.

## Status

Feature-complete commerce layer (Phases 0–7 merged): catalog, inventory, cart,
checkout, orders, customers with magic-link auth, Stripe + x402 payments, tax,
shipping, discounts, entitlements, reporting, and settings — with a staging storefront
deployed to Cloudflare Workers.

## License

MIT
