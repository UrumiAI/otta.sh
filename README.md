# Urumi

A commerce layer for [EmDash](https://github.com/emdash-cms/emdash) — the WooCommerce-equivalent for Cloudflare's TypeScript CMS.

## What this is

Urumi turns an EmDash site into a store. It ships as two parts:

1. **Urumi plugin** — a sandbox-clean EmDash plugin: storefront routes, an on-screen
   "Product data" panel (Block Kit field widget), content-sync hooks, cart/checkout
   orchestration, and x402 gating for digital goods. Talks to the commerce service
   over HTTP only (`network:request` + `allowedHosts`).
2. **Urumi commerce service** — a standalone Node + Postgres service that owns all
   money and stock truth: catalog, inventory, cart, checkout, orders, customers,
   payments, tax, shipping, discounts, webhooks.

## Why two parts

EmDash plugins run sandboxed with no direct DB access and **no atomic write / CAS
primitive**, so safe inventory decrement is impossible inside the plugin. The commerce
service holds the transactional database and performs the one atomic operation that
matters:

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
- **Backend-agnostic authority.** Same `reserve / commit / release` module runs on
  SQLite (dev) and Postgres / D1 (prod).
- **Pluggable payments.** Stripe (async webhook) and x402 (HTTP-402 at the page layer)
  behind one interface.

## Status

Pre-scaffold. Design is fully specified; implementation not yet started.

## License

MIT
