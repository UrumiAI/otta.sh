# Otta — an open-source commerce layer for EmDash

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](https://github.com/UrumiAI/otta.sh/releases/tag/v0.0.1)

Open source (MIT), version 0.0.1. The WooCommerce-equivalent for
[EmDash](https://github.com/emdash-cms/emdash), Cloudflare's TypeScript CMS.

![The Otta storefront: a product listing with three sample products, each showing generated coil artwork, a title, a description, a price, and whether it is in stock — the first is sold out, its price struck through](./docs/storefront.png)

<sub>The reference storefront running locally, with prices and stock served in-process by the
Otta plugin — this is what the [quick start](#quick-start-local-2-minutes) below gives you.</sub>

## What this is

Otta turns an EmDash site into a store. It is **one deployable**, and it ships as two parts:

1. **Otta plugin** — a sandbox-clean EmDash plugin that owns all money and stock truth
   **in-process**: catalog, inventory, cart, checkout, orders, customers, payments, tax,
   shipping, discounts, entitlements, reporting, and webhooks, plus storefront routes,
   content-sync hooks and an admin console (pricing & inventory, orders, reports,
   settings) and x402 gating for digital goods. Commerce state lives in the host's
   per-plugin document store (`ctx.storage`) via the `@otta-sh/store-emdash` adapter — no
   separate service, no second database. Its only outbound egress is `ctx.http.fetch`,
   gated by `network:request` + `allowedHosts`. The CMS owns content; every commercial
   field lives in the plugin's store and is edited in the admin console
   ([ADR-0018](./adr/0018-plugin-owns-commerce-truth-in-process.md),
   [ADR-0020](./adr/0020-one-deployable-plugin-owns-commerce-truth.md)).
2. **The reference site** (`sites/staging`) — a default EmDash site with the plugin already
   registered, so there's something to actually run. It's the storefront in the screenshot
   above and what the [quick start](#quick-start-local-2-minutes) boots: product listing
   pages, cart, and the admin console. Treat it as the worked example to copy from when
   wiring Otta into your own site — it covers **catalog + cart only** today (see
   [Status](#status)).

## Quick start (local, ~2 minutes)

A full store on your laptop — no Cloudflare account, no deploy, no database to run. The
site's D1 content database and R2 media bucket are emulated locally by the Astro Cloudflare
adapter, and commerce runs **in-process** inside the same worker (the plugin owns cart,
order and inventory state in em-dash plugin storage), so there is no separate service and
no Postgres in the loop.

```bash
pnpm install

# 1. Storefront + admin.
pnpm --filter @otta-sh/site-staging dev
```

Then open the dev-only setup bypass, which claims the site and applies the full seed
including three sample products:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

The seed creates the three sample products as CMS **content** only — prices and stock are
commerce fields it does not touch — so give them some:

```bash
# 2. Price, stock and activate the demo products (second terminal).
#    It reads the products' real ids from the CMS (matching the seed's slugs),
#    then prices and stocks each one through the SITE's own admin API — the same
#    route the Pricing & inventory page uses, so the site URL is all it needs.
SITE_URL=http://localhost:4321 \
  pnpm dlx tsx@4 sites/staging/scripts/seed-demo-commerce.ts
```

`/products` now renders a priced catalog and add-to-cart takes a real inventory hold. Open
**Pricing & inventory** in the admin to reprice, restock, or price a product of your own —
that page is the only place commercial fields are edited; the CMS owns the title,
description and images.

One thing to know: this storefront covers **catalog + cart only** — see [Status](#status).

To deploy this for free on Cloudflare Workers, follow
[`DEPLOYMENT.md`](./DEPLOYMENT.md) §2.

## Architecture (summary)

- **Product model = hybrid.** Content (title, description, images, SEO, taxonomies)
  lives in a native EmDash `products` collection; commercial data (price, SKU, stock,
  tax, shipping) lives in the plugin's own document store. Link key = the CMS content `id`.
- **One database.** Commerce truth and CMS content share the site's single D1 database:
  content lives in the CMS's own tables, commerce lives in the host's per-plugin document
  store (`ctx.storage`), namespaced by plugin id and collection. They are not joined in
  SQL — the hybrid product model is joined in app code at render time.
- **Ports and adapters.** `@otta-sh/domain` is pure (no IO); the stores that implement its
  ports live in `@otta-sh/store-emdash`, which writes one document per aggregate to the
  host's per-plugin document store (`ctx.storage`) by compare-and-set — D1 in dev and in
  production, with a dialect harness that runs the same adapters against SQLite and
  Postgres in CI. The plugin composes those stores in-process, and the domain's contract
  suites are the spec they are held to ([ADR-0019](./adr/0019-commerce-aggregates-are-one-document-each.md)).
- **Pluggable payments.** Stripe (async webhook) and x402 (HTTP-402 at the page layer)
  behind one `PaymentGateway` interface.
- **Deployment.** One Worker and one D1 database: the EmDash site with the plugin
  registered trusted (in-process), on the Cloudflare Workers **free** plan, with cron
  sweeps for cart/reservation expiry. The plugin still passes the full workerd sandbox
  suite on every CI run, which is the binding contract (ADR-0006).
  Step-by-step bootstrap guide: [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Repository layout

| Package | What it is |
|---|---|
| `@otta-sh/domain` | Pure ports, use-cases, branded money types, contract-test suites. No IO. |
| `@otta-sh/store-emdash` | Store adapters over the host's per-plugin document store — one document per aggregate, compare-and-set writes. |
| `@otta-sh/payments-stripe` | Stripe `PaymentGateway` adapter (async-webhook, raw-body HMAC). |
| `@otta-sh/payments-x402` | x402 `PaymentGateway` adapter (synchronous page-gate, facilitator-verified). |
| `@otta-sh/plugin` | The EmDash plugin: commerce composition, storefront routes, admin console, content-sync hooks. |
| `@otta-sh/admin-presentation` | Pure admin presentation primitives (money, dates, short ids, status vocabulary) shared by both console surfaces. No IO. |
| `@otta-sh/admin-react` | The React admin console on the `otta-console` native descriptor (ADR-0014) — Orders and Pricing & inventory. |
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

**v0.0.1** — first open-source release. The `@otta-sh/*` packages are all at `0.0.1` and are
not published to npm yet; consume them from the workspace.

The commerce **layer** is feature-complete (Phases 0–7 merged): catalog, inventory,
cart, checkout, orders, customers with magic-link auth, Stripe + x402 payments, tax,
shipping, discounts, entitlements, reporting, and settings.

The reference **storefront** (`sites/staging`) deliberately covers **catalog + cart
only**. The checkout / payment / download pages
([#27](https://github.com/UrumiAI/otta.sh/issues/27)) and the customer account pages are
not built yet — so today you get a browsable catalog and carts with real inventory
holds, but completing a purchase end-to-end means building those pages or driving the
plugin's own commerce routes directly.

## License

MIT
