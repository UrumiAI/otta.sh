# Urumi — an open-source commerce layer for EmDash

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](https://github.com/UrumiAI/otta.sh/releases/tag/v0.0.1)

Open source (MIT), version 0.0.1. The WooCommerce-equivalent for
[EmDash](https://github.com/emdash-cms/emdash), Cloudflare's TypeScript CMS.

![The Urumi storefront: a product listing with three sample products, each showing generated coil artwork, a title, a description, a price, and whether it is in stock — the first is sold out, its price struck through](./docs/storefront.png)

<sub>The reference storefront running locally, with prices and stock served by the commerce
service — this is what the [quick start](#quick-start-local-2-minutes) below gives you.</sub>

## What this is

Urumi turns an EmDash site into a store. It ships as three parts:

1. **Urumi plugin** — a sandbox-clean EmDash plugin: storefront routes, an on-screen
   "Product data" panel (Block Kit field widget), content-sync hooks, cart/checkout
   orchestration, an admin console (catalog, orders, reports, settings), and x402
   gating for digital goods. Talks to the commerce service over HTTP only
   (`network:request` + `allowedHosts`).
2. **Urumi commerce service** — a standalone Node/Hono + Postgres service that owns all
   money and stock truth: catalog, inventory, cart, checkout, orders, customers,
   payments, tax, shipping, discounts, entitlements, reporting, and webhooks.
3. **The reference site** (`sites/staging`) — a default EmDash site with the plugin already
   registered, so there's something to actually run. It's the storefront in the screenshot
   above and what the [quick start](#quick-start-local-2-minutes) boots: product listing
   pages, cart, and the admin console. Treat it as the worked example to copy from when
   wiring Urumi into your own site — it covers **catalog + cart only** today (see
   [Status](#status)).

## Quick start (local, ~2 minutes)

A full store on your laptop — no Cloudflare account, no deploy. The site's D1 content
database and R2 media bucket are emulated locally by the Astro Cloudflare adapter; only
the commerce Postgres is real.

```bash
pnpm install

# 1. Commerce database — any Postgres works; a throwaway container is fastest.
#    (Host port 55432, not 5432, so it can't collide with a local Postgres.)
docker run -d --name urumi-pg \
  -e POSTGRES_USER=urumi -e POSTGRES_PASSWORD=urumi -e POSTGRES_DB=urumi \
  -p 127.0.0.1:55432:5432 postgres:16

# 2. Commerce service — migrates itself forward on boot, then listens on :3000.
PG_CONNECTION_STRING=postgres://urumi:urumi@127.0.0.1:55432/urumi \
  pnpm dlx tsx@4 packages/service/src/index.ts
```

```bash
# 3. Storefront + admin, in a second terminal.
COMMERCE_SERVICE_URL=http://127.0.0.1:3000 pnpm --filter @urumi/site-staging dev
```

Check the service with `curl http://127.0.0.1:3000/health` → `{"ok":true}`. Then open the
dev-only setup bypass, which claims the site and applies the full seed including three
sample products:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

`/products` now renders the catalog, and add-to-cart takes a real inventory hold against
Postgres. Price and stock a product from the admin's **Product data** panel and watch the
service log the sync.

Two things to know: the service is run through `tsx` rather than its built `dist` bin
because the `@urumi/*` packages aren't published yet and their workspace export maps point
at TypeScript sources ([#44](https://github.com/UrumiAI/otta.sh/issues/44)); and this
storefront covers **catalog + cart only** — see [Status](#status).

To deploy this for free on Cloudflare Workers, follow
[`DEPLOYMENT.md`](./DEPLOYMENT.md) §3.

## Why two parts

**EmDash's plugin sandbox has no atomic write, compare-and-set, or transaction.** Plugins
get no direct database access — everything crosses a capability-scoped RPC bridge as JSON
copies — and `ctx.storage` is an unconditional upsert whose declared unique indexes are
silently downgraded. Any read-then-write spans two bridge calls and can interleave, so the
sandbox can't express a guarded update, a uniqueness constraint, or a multi-document
commit. Those are the ordinary building blocks of an order pipeline, so for now the
transactional database sits off to the side, in the commerce service.

The gap is closing. [emdash-cms/emdash#2169](https://github.com/emdash-cms/emdash/pull/2169)
(ours, currently a draft) adds `ctx.storage.<collection>.updateIf(id, { where, set?,
delta? })` — a guarded `UPDATE … RETURNING` run inside the sandbox. Two sibling primitives,
not yet proposed upstream, cover the rest: an atomic `insert` that classifies unique
violations, and `ctx.storage.batch([...])` for all-or-nothing multi-collection writes.
With all three, a `@urumi/store-emdash` adapter already passes the domain's full
`InventoryStore` contract in-process. Once orders, payments, webhooks, and reporting
follow, the split becomes a deployment choice rather than a correctness requirement.

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
  Step-by-step bootstrap guide: [`DEPLOYMENT.md`](./DEPLOYMENT.md).

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

The **concurrency tests are Postgres-required** — better-sqlite3 serializes writes in one
process, so it verifies the SQL is correct, not that it's race-safe under contention. See
`DEVELOPMENT.md` for the TDD / contract-first workflow and commerce invariants.

## Status

**v0.0.1** — first open-source release. The `@urumi/*` packages are all at `0.0.1` and are
not published to npm yet; consume them from the workspace.

The commerce **service** is feature-complete (Phases 0–7 merged): catalog, inventory,
cart, checkout, orders, customers with magic-link auth, Stripe + x402 payments, tax,
shipping, discounts, entitlements, reporting, and settings.

The reference **storefront** (`sites/staging`) deliberately covers **catalog + cart
only**. The checkout / payment / download pages
([#27](https://github.com/UrumiAI/otta.sh/issues/27)) and the customer account pages are
not built yet — so today you get a browsable catalog and carts with real inventory
holds, but completing a purchase end-to-end means building those pages or driving the
service API directly.

## License

MIT
