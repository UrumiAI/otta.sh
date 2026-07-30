# Phase 2 — Catalog Display

_Implementation plan. Written before any code, per `CLAUDE.md` TDD non-negotiable._
_Builds on Phase 0 (service skeleton + atomic inventory) and Phase 1 (product model + sync),
per `draft-plans/implementation-plan.md` Phases table, row 2._

---

## 1. Goal & headline test

**Goal:** storefront PDP and PLP routes/fragments in `@otta-sh/plugin` that render a browsable
catalog by joining EmDash CMS content (title, description, images, SEO, taxonomies) with
commerce-service commercial data (price, stock, currency) **in app code, at render time** —
the two live in separate databases and are never joined in SQL. Taxonomy filtering, full-text
search, and Product/Offer JSON-LD ship in this phase.

**Headline test (from `implementation-plan.md`):**

> Rendering a PDP joins CMS content + service commercial data in app code; a product with
> no commerce record renders as "not purchasable"; Product/Offer JSON-LD emitted.

Decomposed into the exact behavioral cases this phase must turn green (see §7 for the
red→green steps that produce each one):

1. **Join case.** Given a CMS product with id `p1` and a `product_commerce` row for `p1`
   (price `1999` `Cents`, currency `USD`, in stock), rendering the PDP for `p1` produces a
   view model containing both the CMS fields (title, description, images) and the
   commercial fields (formatted price, availability) — sourced from two independent calls
   (CMS content read + commerce-service read), joined by `productId = CMS id` in the
   plugin, never by a cross-database SQL join.
2. **Not-purchasable case.** Given a CMS product `p2` with **no** `product_commerce` row
   (deleted, never priced, or "create, then price" not yet completed — Phase 1 §3), the PDP
   renders successfully with `purchasable: false`, no price, and no add-to-cart affordance,
   instead of throwing, 500ing, or silently omitting the product.
3. **JSON-LD case.** The PDP fragment emits a `<script type="application/ld+json">` block
   that is `schema.org/Product`, and — **only when purchasable** — nests an
   `schema.org/Offer` with `price` (major units, string), `priceCurrency` (ISO 4217), and
   `availability`. A non-purchasable product emits `Product` JSON-LD with no `Offer` node
   (not an `Offer` with a null price — omission, not a null field).
4. **PLP batching case.** Rendering a PLP page of N products (N up to the page size cap)
   issues **exactly one** outbound HTTP call to the commerce service for commercial data,
   not N — see §4.

---

## 2. Scope

### In scope
- PDP (single product) and PLP (listing: all-products, taxonomy-filtered, and search-result
  variants share one rendering path) storefront rendering in `@otta-sh/plugin`.
- The content+commerce join utility (pure, transport-agnostic) and its "not purchasable"
  fallback contract.
- Batched commercial-data fetch: new domain port method + service REST endpoint + plugin
  `CommerceClient` method (§6), plus a request-scoped batching strategy so PLP never does
  N+1 HTTP calls (§4).
- Taxonomy-filtered listing (categories/tags, native EmDash taxonomies) and full-text search
  (EmDash FTS5) over CMS content, feeding the same join/render path.
- Product + Offer JSON-LD emission.
- Price **display** formatting (major-unit string, locale-aware) at the presentation edge —
  the money type itself (`Cents` + `Currency`) stays branded end-to-end; formatting is not a
  domain concern.
- Read-only "in stock" signal for JSON-LD `availability` (a coarse boolean), sourced from the
  commerce service's own DB (service-side join of `product_commerce` + `inventory`, not a
  plugin-side second remote join — see §4).

### Out of scope (explicitly deferred)
- **Cart / add-to-cart action, atomic reserve** — Phase 3. Phase 2 renders a purchasable/
  not-purchasable state and a price; it does not wire an add-to-cart button's submit path or
  touch `InventoryStore.reserve`.
- **Product variations** — deferred past v1 per `design-decisions.md` §6; PDP renders one
  price/one stock signal per product, no variant matrix.
- **Checkout, payments, entitlements** — Phase 4.
- **Reviews/ratings rendering** — tier ① (EmDash comments), not blocked on this phase, but
  not built here; PDP JSON-LD does not need `aggregateRating` yet.
- **Real-time stock accuracy / reservation-aware availability** — the JSON-LD/PLP "in stock"
  signal is a display convenience, not the authority; Phase 3's reserve path is the source of
  truth for whether a purchase actually succeeds.
- **Storefront e2e (Playwright)** — infra doesn't exist yet; noted as pending in §9, not
  built in this phase.

---

## 3. Dependencies

### What this phase requires from Phases 0–1 (must already be green)
- `@otta-sh/domain`: `InventoryStore` port, branded `Cents`/`Currency`/`ProductId` types,
  IO-free use-cases, the domain-purity lint rule.
- `@otta-sh/store-postgres`: Kysely store passing the domain contract suite on SQLite +
  Postgres; a `product_commerce` table keyed by `product_id = CMS id` (Phase 1), and the
  Phase 0 `inventory` table (`sku`, `on_hand`).
- `@otta-sh/service`: REST server that mirrors ports 1:1; live-server contract test harness
  already exists (reused in §6/§7 for the new endpoint).
- `@otta-sh/plugin`: plugin skeleton, `CommerceClient` port + `HttpCommerceClient` adapter
  (transport seam from ADR-0002), `content:afterSave`/`afterPublish`/`afterDelete` sync
  hooks keeping `product_commerce` current, the Block Kit "Product data" field widget, and
  the workerd-on-Node sandbox test harness (Phase 1's sandbox-clean proof).
- `products` CMS collection with taxonomies attached (component-map.md §2) and FTS5 enabled
  on the collection, title-weighted (component-map.md §2 "Product search" row) — this phase
  assumes FTS is **enabled** as CMS config; it does not implement FTS5 itself (EmDash-native),
  only consumes `search()` results.

### What this phase provides to Phase 3 (cart + inventory)
- The join utility and its `{ content, commerce, purchasable }` shape — Phase 3's
  add-to-cart affordance decides whether to render a submit action based on the same
  `purchasable` flag this phase defines.
- The money-formatting boundary (Cents/Currency in, display string out) — Phase 3 reuses it
  for cart line totals; it does not get reinvented.
- The `CommerceClient.getCommerceBatch` method and its service-side endpoint (§6) — Phase 3
  can reuse the batch shape for cart-line pricing lookups if a cart ever needs N products'
  current price at once (e.g., a "prices changed since you added this" check).
- Proof that the plugin can render non-trivial storefront output under the workerd sandbox
  with only `ctx.http` + `allowedHosts` egress — Phase 3's cart routes inherit this pattern
  rather than re-deriving it.

---

## 4. Rendering & join design

### 4.1 Where PDP/PLP actually render (platform-shape assumption — verify first)

Per `component-map.md` §2, storefront display is tier ① ("Astro pages, `page:fragments` …
for add-to-cart + Product/Offer JSON-LD") — i.e., the **product content page and the listing
page are EmDash-native pages** (the `products` collection renders through EmDash's own
content routing), and the plugin's job is to **inject fragments** (JSON-LD script, a
price/availability fragment) into designated slots via the `page:fragments` hook, not to own
a competing PDP/PLP route.

This plan is written against that assumption, but it has **not been verified against EmDash
source** the way `emdash-platform-notes.md` verified the sandbox/storage constraints — the
notes document `page:fragments` as "injects script/style/JSON-LD into public pages" but do
not specify whether the hook is invoked **once per page** (with access to every item shown,
e.g. all N products on a PLP) or **once per rendered item** (once per product card). That
invocation granularity changes how naively batching would work, though it does not change
the recommended design in §4.2, which is invocation-granularity-independent by construction.

**First task of Phase 2 implementation (before any red test is written) is a short platform
spike:** read the EmDash `page:fragments` hook signature and call sites (mirroring how
ADR-0001/0002 verified the sandbox constraints), and confirm:
- Whether PDP/PLP are native content pages with fragment injection, or whether the plugin
  must register its own public storefront routes for `/products` and `/products/:slug`
  (as it already will for cart/checkout in Phase 3).
- The fragment hook's invocation granularity for listing pages.

If the spike shows PDP/PLP need to be plugin-owned routes instead of fragments, §4.2–§4.4 and
the join/JSON-LD/format utilities are unaffected (they are transport-agnostic pure functions);
only the outermost wiring (`page:fragments` handler vs. route handler) changes. Record the
spike's finding in the PR description; if the assumption breaks, open an ADR.

### 4.2 The join, precisely

```ts
// @otta-sh/plugin — pure, no ctx, unit-testable outside the sandbox
interface JoinedProduct {
	content: CmsProductContent;         // title, description, images, seo, taxonomies
	commerce: ProductCommerceView | null; // price (Cents), currency, sku, inStock
	purchasable: boolean;               // false iff commerce === null (or explicitly inactive)
}

function joinProduct(
	content: CmsProductContent,
	commerce: ProductCommerceView | null,
): JoinedProduct;
```

- `commerce === null` covers: no `product_commerce` row synced yet ("create, then price" not
  finished), a soft-deleted commerce record (Phase 1 `afterDelete` behavior), or the batch
  call simply omitting an id it doesn't have (§6 — the endpoint **omits, never 404s,**
  missing ids, consistent with ADR-0002 rule "no status-code-as-logic").
- `purchasable` is a single computed boolean so the fragment/JSON-LD/price-display code never
  independently re-derives "is this thing sellable" — one function, one truth, one test.

### 4.3 PLP batching strategy (avoiding N+1)

Two complementary mechanisms, because the exact fragment invocation granularity is the open
question in §4.1:

1. **Domain/service/transport all gain a batch shape** (§6): `listCommerceByIds` on the
   store port, `POST /catalog/commerce/batch` on the service, `getCommerceBatch` on
   `CommerceClient`. The PLP data loader collects every CMS product id on the current page
   (after CMS pagination/taxonomy-filter/search has already run — a pure tier-① query) and
   issues **one** batched call for the whole page.
2. **A request-scoped micro-batching loader (DataLoader pattern) sits behind
   `CommerceClient.getCommerceByProductId` too**, so that regardless of whether
   `page:fragments` turns out to invoke once-per-page or once-per-item, any set of
   individual lookups issued within the same render pass get coalesced (collected across a
   microtask tick, or a small explicit time window, then flushed as one batched HTTP call)
   before resolving each caller's promise. This makes N+1 avoidance robust to the platform
   spike's outcome instead of depending on it.
   - Loader lifecycle: one loader instance per incoming request/render (new instance per
     `page:fragments`/route invocation — the plugin sandbox does not hand back a persistent
     object across requests per `emdash-platform-notes.md`, so there is no cross-request
     leakage to worry about; each render gets a fresh loader).
   - Cap: batch size capped (default 100 — matches the PLP page-size cap below) so a
     pathological page can't build an unbounded request body.
3. PLP page size is capped (default 24–50, configurable) specifically so the batch endpoint's
   request/response bodies stay small and predictable; taxonomy/search listings paginate
   through the same cap.

### 4.4 Caching

- **CMS content** (title/description/images) already benefits from EmDash's own page
  caching/ISR — out of scope to change here.
- **Commercial data is display-only in this phase** (no reservation happens), so a short TTL
  is acceptable: cache the batch response for a few seconds to tens of seconds (exact number
  is an open question, §8) keyed by the sorted id-set, scoped to the request/render — this is
  a micro-cache to avoid duplicate calls within one render pass, not a cross-request cache
  (cross-request caching of price/stock is a correctness/staleness tradeoff explicitly
  deferred — see §8).
- The cache must **never** be consulted by Phase 3's reserve path — reservation always hits
  the live `InventoryStore.reserve` through the service. This phase's cache only feeds
  read-only rendering.

### 4.5 "Not purchasable" fallback

`purchasable: false` renders:
- No price, no formatted-money string.
- No add-to-cart affordance (Phase 3 will gate its button render on this same flag — Phase 2
  just needs the flag to exist and be correct; Phase 2 itself renders no button at all yet,
  purchasable or not, since add-to-cart wiring is out of scope, §2).
- JSON-LD: `Product` node only, no `Offer` child (§1 case 3).
- The product still renders (title, description, images) — a CMS product without a commerce
  record is "hidden from purchase," not "hidden from the catalog" (matches
  `design-decisions.md` §3: "CMS product without a commerce record = not purchasable").

### 4.6 Price display from integer minor units

- The wire/domain value stays `{ amount: Cents; currency: Currency }` end-to-end — the plugin
  never receives or handles a float.
- A single presentation-layer function, `formatMoney(amount: Cents, currency: Currency,
  locale: string): string`, does the minor→major conversion and `Intl.NumberFormat` locale
  formatting. It lives in `@otta-sh/plugin` (or a small shared, IO-free `@otta-sh/presentation`
  util if Phase 3's cart needs the identical function — decide by "does a second real
  consumer exist yet," per ADR-0002 rule 5; today only the plugin needs it, so start in
  `@otta-sh/plugin`).
- This function is the **only** place a money value is allowed to touch a `number`/string
  boundary; it takes branded types in, never a bare `number`. A type-level negative test
  (mirroring Phase 0's `Cents` type-test) asserts passing a bare `number` fails to compile.
- Formatting is explicitly **not** a domain concern (`CLAUDE.md`: "formatting stays out of
  the domain") — it lives entirely in the plugin/presentation layer, downstream of the
  branded types the domain defines.

---

## 5. Search & taxonomy design

- **Full-text search lives on the CMS content side** (EmDash FTS5, `site.search()`,
  title-weighted per `component-map.md` §2) — it is a tier-① capability the plugin
  configures/enables, not something Urumi builds. The commerce service has no text index and
  is never queried for search; it is only ever queried for **commercial data on a known set
  of ids** (the ids the CMS search already returned).
- **Taxonomies** (categories/tags) are native EmDash taxonomy CRUD attached to the `products`
  collection (`component-map.md` §2) — filtering a PLP by taxonomy term is a CMS content
  query (`taxonomy = X`), again yielding a paginated set of CMS product ids/content, before
  any commerce lookup happens.
- **One rendering path, three entry points.** All-products PLP, taxonomy-filtered PLP, and
  search-result PLP differ only in *which CMS query produced the page of content* — all three
  feed the same `joinProduct`/batch-commerce/JSON-LD pipeline (§4.2–§4.3). This avoids three
  parallel implementations of the join and batching logic.
- **Non-purchasable items in listings/search:** included, not filtered out, per §4.5 (content
  visibility ≠ purchasability) — flagged as such wherever the PLP renders a price slot. Revisit
  if product/SEO stakeholders want non-purchasable items excluded from search results
  specifically (open question, §8).
- No taxonomy or search data is ever stored in or read from the commerce service.

---

## 6. New service surface

### New domain-level read

Add a **query** method to the existing Phase 1 commerce-record store port (a read, not a
command — no idempotency key needed, it mutates nothing):

```ts
// @otta-sh/domain/ports (extends the Phase 1 ProductCommerceStore port)
interface ProductCommerceStore {
	// existing Phase 1 methods: upsert, getByProductId, softDelete, ...
	listCommerceByIds(productIds: ProductId[]): Promise<ProductCommerceView[]>;
}

interface ProductCommerceView {
	productId: ProductId;
	price: Cents;
	currency: Currency;
	sku: Sku;
	inStock: boolean; // service-side join of product_commerce + inventory.on_hand > 0
}
```

- **Missing ids are omitted from the result array, never an error** — mirrors the "no
  status-code-as-logic" rule and keeps the plugin's join (§4.2) simple: absence ⇒
  `commerce: null` ⇒ `purchasable: false`.
- `inStock` is computed **inside the service**, joining `product_commerce` and `inventory`
  in one Postgres query (both tables live in the same commerce DB — this is an intra-service
  join, not a cross-database one; the "no cross-DB joins" rule in `design-decisions.md` §4
  is about CMS-DB↔commerce-DB, not within the commerce DB itself). This keeps the plugin from
  ever needing a *second* remote batch call (commerce + inventory) to render one price slot.

  > **Invariant — protect this from refactoring (do not weaken without updating this
  > doc):** `listCommerceByIds`/`getCommerceBatch` MUST return `inStock` computed via this
  > single intra-service-DB join. It must never be split into two client-visible round trips
  > (e.g. a separate `getInventoryByIds`-style call from the plugin) to "simplify" the query
  > or to reuse Phase 0's `InventoryStore` port directly from the plugin side — that would
  > reintroduce the very N+1/extra-round-trip problem §4.3 exists to prevent, and would give
  > the plugin a second, redundant path to inventory data. The store-level test (§7 step 2)
  > and the PLP wiring test (§7 step 10) both assert this by call-count, not just by reading
  > the code, so a regression fails a test, not just a review.

### New REST endpoint (mirrors the port 1:1, per ADR-0002 rule 2)

```
POST /catalog/commerce/batch
Body:     { "productIds": string[] }        // capped length, e.g. 100 — 400 if exceeded
Response: { "items": ProductCommerceViewDTO[] }  // only ids that exist; no per-id error entries
```

No pagination/cursor semantics are invented here beyond what the port expresses — the cap is
a request-size guard, not a pagination feature (ADR-0002 rule 2: "no batching/pagination
semantics that don't exist on the port" — the port's batch signature is exactly mirrored).

### New `CommerceClient` transport method

```ts
// @otta-sh/plugin — consumed by the join/loader, never calls fetch directly
interface CommerceClient {
	// existing Phase 1 methods ...
	getCommerceBatch(productIds: ProductId[]): Promise<ProductCommerceView[]>;
}
```

`HttpCommerceClient.getCommerceBatch` POSTs to `/catalog/commerce/batch` over `ctx.http`
within `allowedHosts` — no new capability needed (Phase 1 already declared `network:request`
+ `allowedHosts` for the existing client methods).

### Contract-suite extension

- Extend the existing store contract suite (mirrors `inventoryStoreContract` from Phase 0)
  with `productCommerceStoreContract`, adding: **"`listCommerceByIds` returns records for
  ids that exist and silently omits ids that don't, in no particular guaranteed order."** Run
  against the in-memory fake, SQLite, and Postgres — this is a pure read with no concurrency
  hazard, so (unlike the no-oversell test) it is **not** Postgres-required; it runs on every
  dialect same as the rest of the suite.
- Extend the service's live-server HTTP contract test with the same case run against
  `POST /catalog/commerce/batch`, proving wire ⇄ port fidelity (existing Phase 0 pattern,
  reused, not reinvented).

---

## 7. Ordered red→green steps

Each step: failing test named first, then the minimum code to go green. Plugin-layer tests
run under the workerd-on-Node sandbox (per `CLAUDE.md`), except pure functions with no `ctx`
touchpoint, which may also run as plain vitest unit tests in addition to being exercised by a
sandbox-level integration test further down the list.

**2.0 — Platform spike (§4.1).** Not a test — a short investigation. Confirm `page:fragments`
invocation shape against EmDash source; record the finding in the PR. Blocks nothing below
(§4.3's loader design tolerates either answer), but must land before step 2.7/2.8's outermost
wiring is written, so that wiring targets the right hook/route shape.

1. **Domain: batch read on the store port.**
   `packages/domain/src/catalog/product-commerce-store.contract.test.ts`
   - Test: `"listCommerceByIds returns records for existing ids and omits missing ids"`
   - Code: add `listCommerceByIds` to `ProductCommerceStore`, implement on the in-memory fake
     first (proves the port shape, Phase 0 precedent), run contract suite against it.

2. **Store adapter: Postgres/SQLite implementation.**
   `packages/store-postgres/test/product-commerce.contract.test.ts` (parameterized, both
   dialects, existing `describeEachDialect`-style wrapper)
   - Test: same contract case as step 1, now against real SQL — `inStock` computed via a join
     against Phase 0's `inventory` table (`on_hand > 0`).
   - Test (invariant guard): `"listCommerceByIds issues exactly one SQL query for a batch of N
     ids, including inStock"` — spy/count the query-execution calls on the Kysely connection
     for a batch request; assert exactly 1, protecting the intra-service join invariant (§6)
     from a future refactor into a separate commerce query + a separate inventory query.
   - Code: the Kysely query (`SELECT … FROM product_commerce JOIN inventory … WHERE product_id
     IN (:ids)`), single statement, no interactive transaction (consistent with the
     single-statement-write discipline, though this is a read).

3. **Service: new endpoint, live-server contract test.**
   `packages/service/test/catalog-commerce-batch.http-contract.test.ts`
   - Test: `"POST /catalog/commerce/batch returns items for known ids and omits unknown ids,
     rejects a request over the id cap with 400"`
   - Code: Zod-validated route handler wired to the domain use-case/port, no extra semantics.

4. **Plugin transport: `CommerceClient.getCommerceBatch`.**
   `packages/plugin/src/commerce-client/http-commerce-client.test.ts` (workerd sandbox)
   - Test: `"getCommerceBatch posts productIds to the service over ctx.http within
     allowedHosts and returns the parsed items"`
   - Code: `HttpCommerceClient.getCommerceBatch` implementation.

5. **Request-scoped batching loader.**
   `packages/plugin/src/commerce-client/batching-loader.test.ts`
   - Test: `"N individual getCommerceByProductId calls issued within one render pass coalesce
     into exactly one getCommerceBatch call"`
   - Test: `"a lookup for an id already resolved from a prior batch in this render is not
     re-fetched"`
   - Code: DataLoader-style loader wrapping `CommerceClient`.

6. **Pure join utility.**
   `packages/plugin/src/catalog/join-product.test.ts` (plain unit test, no sandbox needed)
   - Test: `"joinProduct returns purchasable:true with price and inStock when a commerce
     record exists"`
   - Test: `"joinProduct returns purchasable:false and commerce:null when no commerce record
     exists"`
   - Code: `joinProduct` (§4.2).

7. **Money formatting.**
   `packages/plugin/src/presentation/format-money.test.ts`
   - Test: `"formatMoney renders a locale-formatted major-unit string for Cents+Currency"`
   - Type-level test: `"formatMoney does not compile when passed a bare number"`
     (`expectTypeOf`-style, mirrors Phase 0's `Cents` negative type-test)
   - Code: `formatMoney`.

8. **JSON-LD builder.**
   `packages/plugin/src/catalog/product-json-ld.test.ts`
   - Test: `"buildProductJsonLd emits Product+Offer with price, priceCurrency, and
     availability when purchasable"`
   - Test: `"buildProductJsonLd emits Product only, no Offer node, when not purchasable"`
   - Code: `buildProductJsonLd(joined: JoinedProduct): object`.

9. **PDP wiring (fragment or route, per step 2.0's finding).**
   `packages/plugin/src/storefront/pdp.test.ts` (workerd sandbox, exercising the real
   hook/route handler against a fake `CommerceClient` and fake CMS content read)
   - Test: `"rendering the PDP for a product with a commerce record joins content+commerce
     and injects Product+Offer JSON-LD"`
   - Test: `"rendering the PDP for a product with no commerce record renders not-purchasable,
     with Product-only JSON-LD and no price"`
   - Code: the PDP handler, composed from steps 4/6/7/8.

10. **PLP wiring, including the N+1 proof.**
    `packages/plugin/src/storefront/plp.test.ts` (workerd sandbox)
    - Test: `"rendering a PLP page of 25 products issues exactly one commerce batch HTTP
      call"` (spy/count on the fake `ctx.http`)
    - Test (invariant guard): `"rendering a PLP page issues zero HTTP calls to any
      inventory-only endpoint; inStock arrives on the single commerce batch response"` —
      asserts, via the same `ctx.http` spy, that the total call count for the page stays at
      the one commerce-batch call from the test above (§6's intra-service-join invariant, seen
      from the plugin/client side).
    - Test: `"a taxonomy-filtered PLP query narrows the CMS content set before the single
      batch commerce call"`
    - Test: `"a search-result PLP (FTS) query narrows the CMS content set before the single
      batch commerce call"`
    - Test: `"a non-purchasable product still appears in the PLP listing, without a price
      slot"`
    - Code: the PLP handler, reusing steps 4–8; three thin query-source adapters (all
      products / taxonomy-filtered / search) feeding one render path (§5).

**Phase 2 Definition of Done** gate — see §9.

---

## 8. Risks & open questions

| # | Risk / question | Recommended resolution |
| --- | --- | --- |
| 1 | `page:fragments` invocation granularity for listings is unverified against EmDash source (§4.1). | Do the platform spike (step 2.0) before wiring PDP/PLP; the join/loader/JSON-LD/format code is unaffected either way. If fragments can't batch at the page level, the request-scoped loader (§4.3.2) is the fallback that still gets to one HTTP call. |
| 2 | Whether PDP/PLP are EmDash-native pages (fragment injection) or must become plugin-owned public routes. | Same spike resolves it; if routes are required, treat them like Phase 3's storefront routes (already a known pattern) — no new architecture, just earlier arrival of a pattern Phase 3 needs anyway. |
| 3 | Micro-cache TTL for commercial display data (§4.4) is unspecified. | Default to no cross-request cache in v1 (only the intra-render loader dedupe); add a short TTL (single-digit seconds) only if load-testing shows the service needs it. Never let this cache touch the reserve path. |
| 4 | Should non-purchasable products be excluded from search/PLP entirely, or shown flagged (current recommendation, §4.5/§5)? | Ship "shown, flagged" for v1 (content stays discoverable/SEO-indexable); revisit with product input if it causes user confusion. |
| 5 | JSON-LD `availability` is a coarse `inStock` boolean, not reservation-aware — could say "InStock" moments before a concurrent buyer takes the last unit. | Acceptable for v1: JSON-LD/PLP display is not the authority; Phase 3's `reserve` is. Document this explicitly in the JSON-LD builder's doc comment so it isn't mistaken for a stronger guarantee later. |
| 6 | Batch endpoint id-count cap (100 suggested) and PLP page-size cap (24–50 suggested) are placeholders. | Pick page-size from a UX/perf pass, not architecture; keep the batch cap ≥ page-size cap with headroom (e.g. 2×) so a single page render never needs to split into multiple batch calls. |
| 7 | `formatMoney`'s home package (`@otta-sh/plugin` vs. a new shared presentation package) may need to move once Phase 3's cart wants it too. | Start in `@otta-sh/plugin` per ADR-0002 rule 5 ("add an adapter/package only when a second real consumer exists"); extract when Phase 3 actually needs it, as a refactor with its own PR, not speculatively now. |
| 8 | Reviews/ratings and `aggregateRating` in JSON-LD are out of scope, but the JSON-LD builder shape should not preclude adding it later. | `buildProductJsonLd` takes a plain object; adding an optional `aggregateRating` field later is additive — no redesign needed, just confirm the builder doesn't hardcode the exact key set in a way that would break. |

---

## 9. Definition of done

- [ ] Platform spike (step 2.0) completed and its finding (fragment-injection vs. plugin
      route) recorded in the PR description.
- [ ] `productCommerceStoreContract`'s new `listCommerceByIds` case green against the
      in-memory fake, SQLite, **and** Postgres (not Postgres-required — it's a pure read).
- [ ] Service live-server contract test for `POST /catalog/commerce/batch` green (wire ⇄ port
      fidelity, including the id-cap 400 case).
- [ ] All plugin-layer tests (transport, loader, join, format, JSON-LD, PDP, PLP) green
      **under the workerd-on-Node sandbox** — not merely in trusted in-process mode
      (`CLAUDE.md` non-negotiable).
- [ ] Headline test's three cases (§1) all pass: join renders both content and commerce data;
      no-commerce-record renders `purchasable:false` with no price/Offer; JSON-LD emits
      Product(+Offer) correctly in both states.
- [ ] PLP N+1 proof passes: one batch HTTP call for a full page, verified by a call-count
      assertion against the fake `ctx.http`, not just "it looks fast."
- [ ] Intra-service `inStock` join invariant protected by tests, not just doc comments: the
      store-level call-count test (§7 step 2) and the PLP-level "zero inventory-only HTTP
      calls" test (§7 step 10) are both green.
- [ ] `formatMoney`'s negative type-test (bare `number` rejected) fails to compile as
      expected.
- [ ] `@otta-sh/domain` still imports nothing with IO (boundary lint green) — this phase adds a
      read method to an existing port, not a new IO dependency.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format` all clean; changeset added for
      any published package touched (`@otta-sh/domain`, `@otta-sh/service`, `@otta-sh/plugin`).
- [ ] Storefront Playwright e2e / screenshot: **pending**, not part of this phase's gate —
      storefront e2e infra does not exist yet (`CLAUDE.md` §"Verification before merge" notes
      this as "once storefront e2e exists"). Flag explicitly in the PR that this is
      intentionally deferred, not skipped.
- [ ] PR tagged `[Plugin]` (primary surface) with a secondary note calling out the
      `[Domain]`/`[Service]` port+endpoint addition if not split into a separate PR (prefer
      splitting per "one PR = one thing" if the domain/service change is substantial enough
      to review independently of the plugin wiring).

---

## 10. Revision log (post-approval review fold-in)

- **Intra-service `inStock` join needs protecting from a future refactor into two
  client round-trips (Reviewer A should-fix, Reviewer B should-fix).** Resolution: added an
  explicit "protect this" invariant callout to §6 stating `listCommerceByIds`/
  `getCommerceBatch` must never split into a separate inventory call, and backed it with two
  new tests rather than doc-comment-only discipline: a store-level call-count assertion (§7
  step 2, "exactly one SQL query for a batch, including inStock") and a PLP-level assertion
  (§7 step 10, "zero HTTP calls to any inventory-only endpoint"). Added both to the §9 DoD.
- **Port method-name drift, `getByProductId` (used here) vs. `get` (Phase 1's original
  name) (Reviewer A nit, Reviewer B nit).** Resolution: resolved at the source — Phase 1's
  plan now names the port method `getByProductId` throughout (see that plan's revision log),
  so this plan's existing `getByProductId` references (§6) were already correct and needed no
  change; confirmed no remaining `.get`-only reference exists in this file.
- **`listCommerceByIds` correctly not Postgres-required (Reviewer A nit).** No change — the
  plan already states this correctly (§6, §9); recorded as reviewed and agreed.
- **JSON-LD `availability` coarseness (Reviewer B nit/best-practice).** No change — already
  documented as a v1 tradeoff with a recommended doc-comment (§8 risk 5); nothing further to
  fold in.
- **Skipped as out-of-scope for this pass:** none — both reports' Phase 2 findings were
  addressed or already satisfied.
