---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Phase 2 — catalog display (batch commerce read + storefront PDP/PLP).

- `@otta-sh/domain`: additive `listCommerceByIds(productIds)` query on the
  existing `ProductCommerceStore` port returning `ProductCommerceView`
  (`productId`, `sku`, branded `price`, coarse `inStock`, and the `active`
  publish flag) — missing / soft-deleted / commerce-incomplete ids are
  silently omitted, never errors ("no status-code-as-logic"); INACTIVE rows
  are returned flagged, and purchasability is gated at the plugin's join
  (`purchasable ⟺ commerce !== null && commerce.active`, plan §4.2's "or
  explicitly inactive" arm). Until the deferred afterPublish→activate wiring
  lands (its own follow-up task), every row is `active=false` and
  storefronts honestly render the whole catalog not-purchasable. Implemented
  on the in-memory fake (with an `inventoryOnHand` seam mirroring the
  store's inventory join) and pinned by five new
  `productCommerceStoreContract` cases; harnesses grow `seedStock` and
  `activate`.
- `@otta-sh/store-postgres`: `KyselyProductCommerceStore.listCommerceByIds` as
  ONE statement — `product_commerce LEFT JOIN inventory` with the
  commerce-complete guards inline, identical on sqlite + pg. The §6
  "inStock is one intra-service statement, never a second inventory round
  trip" invariant is enforced by a query-count test (a Kysely plugin counts
  root statement executions: exactly 1 per batch, 0 for an empty batch).
- `@otta-sh/service`: `POST /catalog/commerce/batch` (own route file), a 1:1
  serialization of the port: Zod-validated `{ productIds }` capped at 100
  (a request-size guard ≥2× the PLP page cap, not pagination — 400 over
  cap), `{ items }` response with money as integer + ISO-4217 string.
  Live-server contract test on Postgres.
- `@otta-sh/plugin`: the catalog-display stack, all behavior proven under the
  REAL workerd sandbox. `getCommerceBatch` on `CommerceClient`/
  `HttpCommerceClient` (over `ctx.http` + `allowedHosts` only); a
  request-scoped DataLoader-style `CommerceBatchLoader` (same-tick lookups
  coalesce to one HTTP call; intra-render dedupe only — no cross-request
  cache in v1); the pure `joinProduct` content+commerce join
  (`purchasable ⟺ commerce !== null`, one computed truth); `formatMoney` +
  `majorUnits` behind the plugin's own branded `Cents`/`Currency` (a
  documented mirror of the domain's — the sandbox bundle stays
  self-contained), with a negative type-test making a bare `number`
  amount a compile error and integer-string minor→major conversion (no
  float ever touches an amount); `buildProductJsonLd` emitting schema.org
  Product with an Offer nested only when purchasable (offers key ABSENT
  otherwise — omission, not null). Per ADR-0003 (the `page:fragments` hook
  is trusted-only, unavailable to a sandboxed plugin) PDP/PLP ship as
  plugin-owned PUBLIC routes `storefront/product` and `storefront/list`
  returning localized, RTL-safe JSON view models (+ JSON-LD graph) for a
  thin theme page to render; availability is a semantic token themes
  localize; the PLP page cap (48) plus the loader guarantee the headline
  N+1 gate — one page render issues exactly ONE commerce-batch HTTP call
  and ZERO inventory-only calls (both pinned by call-count sandbox tests);
  non-purchasable items — the no-commerce AND the inactive kind alike — are
  shown and flagged, not filtered; unexpected render failures collapse to a
  structured, message-free `RENDER_FAILED` instead of leaking internals
  through the public route envelope; and a money-parity test pins the
  plugin's branded-money mirror against the domain's. The PDP view
  model carries the marked `slots.addToCart` extension seam Phase 3
  group E hangs its affordance on, gated on the same `purchasable` flag.
