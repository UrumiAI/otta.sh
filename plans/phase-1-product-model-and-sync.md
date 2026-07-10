# Phase 1 — Product model + sync

_Implementation plan (no code). Principal-engineer sequencing for Phase 1 of Urumi._

> Governing rule (DEVELOPMENT.md §1, CLAUDE.md): **failing test → code → green → refactor.**
> A step is done only when its named test is green. New service surface is contract-first:
> the behavioral test is written against the **port** before any adapter. The plugin is
> **sandbox-clean** and proven under **workerd-on-Node**, Block Kit only, egress only via
> `ctx.http` + `allowedHosts`.

Grounding facts verified against the EmDash clone (`~/em-dash`) are cited inline as
`emdash: <path>` so the plan doesn't drift from the real platform surface.

---

## 1. Goal & headline test

**Goal.** Wire the hybrid product model end-to-end: a native EmDash `products` collection
owns content; the commerce service owns commercial data in a `product_commerce` row keyed by
the CMS content `id`; the Urumi plugin (`@urumi/plugin`) keeps them in sync via content
lifecycle hooks and lets an editor set commercial fields from a Block Kit "Product data"
panel. This is the first phase that introduces `@urumi/plugin`; it consumes the `CommerceClient`
transport port (ADR-0002 §3) and a new `ProductCommerceStore` storage port added to Phase 0's
domain.

**Headline behavioral cases (write-first):**

1. **Upsert on save.** `content:afterSave` for a `products` document with `isNew:false`
   upserts a `product_commerce` row keyed by the CMS `id` (`product_id = content.id`). Firing
   the hook twice with the same content + same `idempotencyKey` yields exactly one row, updated
   in place (no duplicate, no error).
2. **Soft-delete on delete.** `content:afterDelete` for that `product_id` sets
   `deleted_at` (row retained, `active=false`); a subsequent `get` returns the row marked
   deleted / not-purchasable, and the underlying inventory/price data is preserved (never a
   hard `DELETE`).
3. **Create-then-price.** Commercial fields are rejected **before** the CMS `id` exists.
   Two enforced layers:
   - **UX:** on a brand-new unsaved product (`isNew` / no `id`), the Block Kit panel renders a
     disabled "save the product first to add pricing" state — no commercial write is possible.
   - **API/domain:** a `ProductCommerceStore.upsert` (or the service `PUT /products/:id/commerce`)
     called with a missing/empty `product_id` is **rejected** (`400` / domain
     `MISSING_PRODUCT_ID`) before any row is minted. Test asserts the reject, not a silent
     create.
4. **Money integrity.** A commercial upsert stores `price` as integer minor units with an
   explicit `currency`; a `number` reaching the price field is a compile error (branded `Cents`,
   DEVELOPMENT.md §4). A type-level test asserts the negative case fails to compile.
5. **Sandbox-clean proof.** Cases 1–3 run with the plugin loaded **under the workerd-on-Node
   sandbox** (not trusted in-process). A CI/guard test asserts the plugin declares only
   `content:read` + `network:request` (with `allowedHosts`) and has no DB/storage-write surface.

---

## 2. Scope

**In scope:**
- EmDash `products` collection definition (content fields: title, slug, Portable Text
  description, gallery/media refs, SEO) — a CMS config artifact shipped with the plugin.
- `@urumi/plugin` package bootstrap: `definePlugin` manifest, capabilities, `allowedHosts`.
- The `CommerceClient` transport port + `HttpCommerceClient` adapter (ADR-0002 §3) — the
  slice of methods this phase needs (`upsertProductCommerce`, `getProductCommerce`,
  `softDeleteProductCommerce`).
- Content lifecycle sync hooks: `content:afterSave` → upsert, `content:afterDelete` →
  soft-delete. (`afterPublish` → activate is a thin follow-on; see §4.)
- Block Kit "Product data" `fieldWidget` (commercial fields: SKU, price, currency, stock,
  tax class, shipping dims) with its own save action → plugin route → service.
- A plugin `route` (`POST .../product-commerce`, non-public) that the panel's save action
  posts to; it validates and calls `CommerceClient`.
- New domain port `ProductCommerceStore` + `store-postgres` adapter + contract suite +
  service REST endpoints (§7).
- workerd-on-Node sandbox test harness for the plugin (§6, first step).

**Out of scope (deferred):**
- **Variations / variant matrix** — deferred past v1 (design-decisions §6). `product_commerce`
  is one row per product; no variant table.
- **Storefront rendering** (PDP/PLP, the content↔commerce join, JSON-LD, FTS) — **Phase 2**.
- Cart, inventory reserve/commit/release wiring through the plugin — Phase 3 (Phase 0 already
  owns the atomic authority; Phase 1 does **not** call `reserve`/`commit`/`release`/`adjust`).
  Phase 1 **does** perform exactly one write to `inventory`: a create-if-absent seed of the
  initial `on_hand` for a newly-priced SKU, via a dedicated additive method — see §4/Risk 4 for
  the explicit resolution (this is not the reserve/commit/release path and does not reopen
  Phase 0's table to ad-hoc writes).
- Payments, entitlements, x402, checkout — Phase 4.
- Reconcile cron for drift repair — noted as a follow-on hook; the **minimum** here is
  save/delete sync. (Recommend landing the cron in Phase 1 only if cheap; otherwise Phase 2.)
- Customer accounts, orders, emails — Phase 5.
- Rich React widget (trusted-only) — explicitly not built; Block Kit only.

---

## 3. Dependencies

**Depends on Phase 0 (exact parts):**
- `@urumi/domain` — branded types (`Cents`, `Currency`, `Sku`, `ProductId`, `IdempotencyKey`),
  the ports directory + port-first test convention, and the in-memory fake pattern
  (Phase 0 §0.2). Phase 1 **adds** `ProductCommerceStore` alongside `InventoryStore`.
- `@urumi/store-postgres` — the Kysely dialect-parameterized store, forward-only migration
  runner, and `describeEachDialect`-style contract wrapper (Phase 0 §0.4). Phase 1 adds a
  migration + a `ProductCommerceStore` implementation.
- The shared **contract-suite pattern** (`inventoryStoreContract`, Phase 0 §0.3) — Phase 1
  mirrors it with `productCommerceStoreContract`.
- `@urumi/service` — the Hono-style REST app, `Idempotency-Key` header → domain
  `IdempotencyKey`, zod validation, no-status-code-as-logic rule, live-server contract-test
  harness (Phase 0 §0.6). Phase 1 adds product-commerce endpoints.
- The dependency-boundary lint rule (domain imports no IO) stays green.

**Provides to Phases 2–4:**
- The `product_commerce` **model + link key (`product_id = CMS content id`)** — the join
  target Phase 2's PDP/PLP reads (a product with no live `product_commerce` row renders
  *not purchasable*; Phase 2 headline test).
- `ProductCommerceStore.getByProductId` / the service read endpoint — consumed by Phase 2 rendering.
- `active` / `deleted_at` semantics — Phase 2 uses them to decide purchasability; Phase 4
  order line items snapshot from the price/title present at purchase (soft-delete never
  rewrites history).
- The `HttpCommerceClient` + plugin manifest scaffold — Phases 2–4 extend the same client
  with cart/checkout methods rather than re-introducing `fetch`.

---

## 4. Data & sync design

**Hybrid product model (design-decisions §3).** Content lives in the EmDash `products`
collection (content DB). Commercial data lives in commerce Postgres. **No field is
duplicated** across the two; they are joined in app code at render time (Phase 2). The two
databases are separate — **no cross-DB join** ever.

**Link key.** `product_commerce.product_id` **= the CMS content `id`**. The id is minted by
EmDash on first save (`emdash: ContentHookEvent.isNew` distinguishes the first save; the id
is present on `event.content.id`). This is why "create then price" exists: no commercial row
can be keyed until the CMS mints the id.

**`product_commerce` schema (forward-only migration).** One row per product.

| column | type | notes |
|---|---|---|
| `product_id` | text **PK** | = CMS content id; the link key |
| `sku` | text, **unique** (nullable until set) | branded `Sku` in domain |
| `price_cents` | bigint / integer | **integer minor units** — never float (repo-wide `_cents` naming convention, Phase 0 §6) |
| `price_currency` | text (ISO-4217) | explicit currency travels with the amount (`Cents` is branded with currency) |
| `tax_class` | text nullable | free-form class id; tax engine is Phase 6 |
| `weight_grams` | integer nullable | shipping dims as integers |
| `length_mm` / `width_mm` / `height_mm` | integer nullable | integer units, no floats |
| `product_kind` | text | `physical` \| `digital` (v1 scope; no variations) |
| `active` | boolean, default false | `afterPublish` flips true; unpublished/new = false |
| `deleted_at` | timestamptz nullable | soft-delete tombstone |
| `idempotency_key` | text nullable, **NOT unique** | per-row "last applied" sync key (dedupe; compare-on-write, see below) |
| `created_at` / `updated_at` | timestamptz | audit |

Money rule (DEVELOPMENT.md §4, CLAUDE.md non-negotiables): `price_cents` is only ever set
from a branded `Cents`; the domain type makes a raw `number` a compile error. Amount +
currency are a unit — no bare integer without its currency.

**Soft-delete semantics.** `afterDelete` sets `deleted_at = now()` and `active = false`; the
row and its commercial data are retained (needed for order history integrity and drift
diagnosis). `get` returns the row with a `deleted`/`notPurchasable` marker; it never hard-
deletes. `emdash: ContentDeleteEvent.permanent` distinguishes trash vs permanent delete —
recommend: **soft-delete on both**, and only consider hard purge on `permanent:true` behind a
later retention policy (open question §8).

**Idempotent upsert — what is the `idempotencyKey` for a sync?** A content save is naturally
replayable (hook re-fires, cron reconcile re-pushes). The upsert is keyed on `product_id`
(PK upsert = inherently idempotent for the *row identity*), but the **command** also carries
an `idempotencyKey` per DEVELOPMENT.md §4 so a replay is a provable no-op rather than a blind
overwrite. Recommended key: a **content-version / revision-derived key** —
`${product_id}:${content.updatedAt or revisionId}` — so re-firing the *same* save is deduped,
while a genuinely newer edit (new revision) produces a new key and applies. (EmDash content
carries revision/updated metadata; confirm the exact field — §8.) The store records
`idempotency_key`; an upsert whose incoming key equals the stored key is a no-op returning the
existing row. This satisfies the "replay decrements/writes once" contract case.

**Explicit semantics (resolving the per-row vs. global-unique ambiguity):**
`product_commerce.idempotency_key` is a **per-row, mutable "last applied key" compared on
write** — it is **not** a global `UNIQUE` constraint like Phase 0's
`reservations.idempotency_key`. The two mechanisms solve different problems: Phase 0's
reservations are create-once-per-key rows (a global `UNIQUE` correctly rejects a second
insert with the same key); `product_commerce` is upserted by `product_id` across the
product's whole lifetime, and the *same* `product_id` legitimately gets a fresh
`idempotency_key` on every real edit. A global `UNIQUE(idempotency_key)` here would be wrong
— it would reject a legitimate re-edit that happens to reuse an ordering-derived key, and
serves no replay-safety purpose a per-row compare doesn't already provide. **Do not add a
uniqueness constraint to this column.** The contract case is: "upsert with the same
`idempotency_key` as the stored row is a no-op returning the existing row; upsert with a new
`idempotency_key` applies and overwrites the stored key."

**Failure / retry when the service is unreachable during a hook.** `content:afterSave` is a
fire-and-forget, read-only-capability notification (`emdash: afterSave requires only
content:read`); it must **not** block or fail the CMS save. Design:
- The hook calls `HttpCommerceClient` with a short timeout. On network failure / 5xx, it
  **does not throw** into the CMS save path — it logs and enqueues for reconcile.
- Because there is no plugin-side transactional queue (sandbox has no atomic storage —
  `emdash: ctx.storage.put` is an unconditional upsert, no CAS), durable retry lives in the
  **reconcile cron** (`cron` hook), which re-derives desired commercial state from CMS content
  and re-pushes any `product_commerce` rows whose `idempotency_key` is stale/missing. The
  service upsert being idempotent makes reconcile safe to run repeatedly.
- Ordering: `afterPublish` (activate) may arrive before a successful `afterSave` upsert on a
  flaky link; the upsert is `active`-aware (publish sets active, save preserves current active
  unless content state says otherwise) so out-of-order delivery converges.

---

## 5. Plugin architecture

**Manifest / permissions (`emdash: definePlugin`, `packages/core/src/plugins/types.ts`).**

```
definePlugin({
  id: "urumi",
  version,
  capabilities: ["content:read", "network:request"],   // nothing else
  allowedHosts: [COMMERCE_SERVICE_HOST],                // e.g. "commerce.example.com" or "*.urumi.internal"
  hooks: { "content:afterSave", "content:afterDelete", "content:afterPublish"?, "cron"? },
  routes: [{ path: "product-commerce", public: false, input: <zod> }],
  admin: { fieldWidgets: [ productDataWidget ] },
})
```

- **`network:request` + `allowedHosts`** are the *only* egress; the host validates every
  `ctx.http.fetch` against `allowedHosts` + SSRF (`emdash: createHttpAccess`,
  `context.ts:619`). No `network:request:unrestricted`.
- **No `storage`/`kv`/DB capability** — the plugin holds no commercial state. A guard test
  asserts the manifest's capability set is exactly `{content:read, network:request}`.
- `content:afterSave` needs only `content:read` (`emdash: hooks.ts:281`), so declaring
  `content:read` (not `content:write`) is sufficient and minimal — the plugin never writes CMS
  content.

**CommerceClient (transport port, ADR-0002 §3 / adapter-architecture §2).** Storefront routes
and the widget's save route depend on the `CommerceClient` **interface**, never on `fetch`.

```
interface CommerceClient {
  upsertProductCommerce(input: UpsertProductCommerceInput, key: IdempotencyKey): Promise<ProductCommerce>;
  getProductCommerce(productId: ProductId): Promise<ProductCommerce | null>;
  softDeleteProductCommerce(productId: ProductId, key: IdempotencyKey): Promise<void>;
}
```

- `HttpCommerceClient` serializes each call over `ctx.http` (`+ allowedHosts`), sending
  `Idempotency-Key` as a header, mirroring the service REST 1:1 (adapter-architecture rule #2 —
  no status-code-as-logic; a 409/replay resolves to the same domain result).
- `InProcessCommerceClient` is **not** built (deferred; adapter-architecture §6).

**Block Kit "Product data" panel (`emdash: FieldWidgetConfig`).** Sandboxed ⇒ Block Kit
`elements`, **not React** (React is trusted-only — DEVELOPMENT.md §5). `FieldWidgetConfig =
{ name, label, fieldTypes, elements }`. Field layout (commercial only):
- SKU (text), Price (integer minor-units input) + Currency (select), Stock/on-hand (integer —
  **create-only**: writable only while no `inventory` row exists for the SKU yet; once a row
  exists the field becomes **read-only display**, and further stock changes go exclusively
  through Phase 3's `reserve`/`commit`/`release`/`adjust` — see Risk 4 for the exact mechanism
  and why a blind overwrite is unsafe), Product kind (physical/digital select), Tax class
  (select/text), Shipping dims (weight/length/width/height integer inputs), plus the panel's
  **own Save action**.
- The widget's data is **routed to the service, not saved into the CMS field** (else it lands
  in the content DB and breaks the split — design-decisions §3). Mechanism: the panel's Save
  action `POST`s to the plugin route `product-commerce`, which calls `CommerceClient.upsert`.

**"Create then price" enforcement (both layers):**
- **UX:** when the product is new / has no minted `id` (`emdash: event.isNew` on the editor
  side / absence of `content.id`), the panel renders the fields disabled with a "save the
  product first" notice; the Save action is not offered. No commercial write is reachable.
- **API/domain:** the plugin route + `ProductCommerceStore.upsert` reject a missing/empty
  `product_id` (`MISSING_PRODUCT_ID` / HTTP 400) before any row is created — enforced
  server-side so a hand-crafted request can't bypass the UX.

---

## 6. Ordered red→green steps (TDD)

Each step: **named failing test first, then the minimum code to green.** Test file paths are
under the package that owns the behavior.

**Step 1 — workerd-on-Node sandbox harness (its own step; no product logic yet).**
- Test: `packages/plugin/test/sandbox-harness.test.ts` →
  `it("loads @urumi/plugin under workerd-on-Node and reaches a stub service only via ctx.http")`.
- Build a reusable harness that boots the plugin in the **workerd sidecar** (mirror
  `emdash: packages/workerd` `createSandboxRunner` + bridge-handler; the EmDash
  `plugin-integration.test.ts` pattern — real SQLite + migrations, exercise the bridge, not
  trusted in-process). Stand up a **stub commerce HTTP server** on an ephemeral port added to
  `allowedHosts`. Assert: a plugin `ctx.http.fetch` to the stub succeeds, and a fetch to a
  host **not** in `allowedHosts` is rejected by the host bridge.
- Green when: the empty plugin loads sandboxed and egress obeys `allowedHosts`. This harness is
  the substrate for Steps 5–8.

**Step 2 — domain port + fake (contract-first).**
- Test: `packages/domain/test/product-commerce-store.test.ts` with the four behavioral cases
  (upsert-inserts, upsert-updates-in-place, soft-delete-sets-tombstone, replay-same-key-no-op)
  against an **in-memory fake `ProductCommerceStore`**. Plus a type-level test:
  `price` field rejects a raw `number` (branded `Cents`) — asserted to fail compilation.
- Code: add `ProductCommerceStore` interface + `UpsertProductCommerceInput` (branded money)
  to `@urumi/domain/ports`, a thin use-case (`upsertProductCommerce`, `getProductCommerce`,
  `softDelete`), and the in-memory fake in domain test-utils. Reject empty `product_id`
  (`MISSING_PRODUCT_ID`).
- Green when: four cases pass on the fake; negative money type-test fails to compile.

**Step 3 — lift into the shared contract suite.**
- Test: extract `productCommerceStoreContract(makeStore, { dialect })`; run it against the
  in-memory fake first (proves the suite is real before any DB), mirroring Phase 0 §0.3.
- Green when: the contract passes against the fake.

**Step 4 — `store-postgres` adapter on both dialects.**
- Forward-only migration adding `product_commerce` (schema §4) with PK `product_id`, unique
  `sku`, and a **non-unique** `idempotency_key` column implementing per-row
  compare-on-write replay dedupe (§4 — explicitly not a global `UNIQUE`, unlike Phase 0's
  `reservations.idempotency_key`).
- Implement `ProductCommerceStore` in `@urumi/store-postgres` (Kysely, dialect-agnostic).
  Upsert = single conditional statement (`INSERT … ON CONFLICT (product_id) DO UPDATE`),
  keeping the single-statement portable shape (adapter-architecture §2). Soft-delete =
  conditional `UPDATE … SET deleted_at`.
- Test: run `productCommerceStoreContract` via the `describeEachDialect` wrapper — **SQLite
  always, Postgres when `PG_CONNECTION_STRING` set / in CI**, per-test schema isolation.
- Green when: contract green on **both** dialects. (No concurrency/oversell test here — that
  invariant is inventory, Phase 0/3; product-commerce is not a race target.)

**Step 5 — service REST endpoints (wire ⇄ port fidelity).**
- Endpoints (§7) mirroring the port 1:1: `PUT /products/:id/commerce`,
  `GET /products/:id/commerce`, `DELETE /products/:id/commerce` (soft). `Idempotency-Key`
  header → domain key; zod bodies; `MISSING_PRODUCT_ID`/empty id → 400 (no status-code-as-
  logic beyond faithful serialization).
- Test: `packages/service/test/product-commerce-http.test.ts` runs the **same behavioral
  cases** against a **live test server** backed by Postgres (Phase 0 §0.6 harness).
- Green when: HTTP contract test green against a live server.

**Step 6 — `HttpCommerceClient` against the live service (transport contract).**
- Test: `packages/plugin/test/http-commerce-client.test.ts` runs the client-side contract
  suite against `HttpCommerceClient` over a live test server (DEVELOPMENT.md §3 — the wire must
  not drift from the port). Assert `Idempotency-Key` is sent and replay is a no-op.
- Code: `HttpCommerceClient` in `@urumi/plugin` implementing `CommerceClient` via injected
  `ctx.http.fetch`.
- Green when: transport contract green.

**Step 7 — sync hooks (the headline).**
- Tests (under the Step-1 sandbox harness, plugin loaded in workerd), file
  `packages/plugin/test/sync-hooks.sandbox.test.ts`:
  - `it("content:afterSave upserts a product_commerce row keyed by CMS id")` — fire the hook
    with `{ content:{id}, collection:"products", isNew:false }`; assert one row via the stub/
    real service.
  - `it("content:afterSave replay with same key upserts once")`.
  - `it("content:afterDelete soft-deletes the product_commerce row")`.
  - `it("create-then-price: commercial write with no CMS id is rejected")` — assert the route/
    service returns the reject before minting a row.
  - `it("afterSave failure does not throw into the CMS save path")` — stub returns 503; assert
    the hook resolves (logs/enqueues) rather than rejecting.
- Code: register `content:afterSave` → derive `idempotencyKey` from revision (§4) → call
  `CommerceClient.upsert`; `content:afterDelete` → `softDelete`; optional `afterPublish` →
  activate. Guarded, non-throwing failure handling.
- Green when: all hook cases pass **in the sandbox**.

**Step 8 — Block Kit "Product data" widget + save route + guard.**
- Tests:
  - `it("Product data widget declares Block Kit elements and commercial field layout")` —
    assert `FieldWidgetConfig.elements` present (no React), fields per §5.
  - `it("new product (no id) renders disabled create-then-price state")`.
  - `it("panel save action posts to the product-commerce route and upserts via the service")`.
  - **Guard:** `it("plugin manifest declares only content:read + network:request and no
    storage/db surface")` — the sandbox-clean CI check (DEVELOPMENT.md §5).
- Code: the `fieldWidget` definition, the non-public `product-commerce` route (zod input →
  `CommerceClient.upsert`), the disabled-state logic.
- Green when: widget + route + guard tests pass under the sandbox.

**Step 9 — (optional, if cheap) reconcile cron.** Test: `cron` hook re-pushes a
`product_commerce` row whose `idempotency_key` is stale after a simulated failed `afterSave`;
idempotent upsert makes it converge. Otherwise defer to Phase 2 and note it.

---

## 7. New service surface

**New domain ports (`@urumi/domain`):**
- `ProductCommerceStore { upsert(input, key), getByProductId(productId), softDelete(productId, key) }`
  — intent, not SQL; `upsert` contract = "insert-or-update by `product_id`, idempotent under
  `key`, reject empty `product_id`". `getByProductId` returns the row incl.
  `active`/`deleted_at`. (Named `getByProductId`, not `get`, so the single-argument identity
  it reads by is unambiguous at every call site — Phase 2 already refers to it by this name;
  see that plan's revision log.)
- `UpsertProductCommerceInput` — branded (`ProductId`, `Sku`, price as `Cents` + `Currency`,
  integer dims, `product_kind`). A raw `number` price is a compile error.
- `CommerceClient` **grows** the three product-commerce methods (transport port; the plugin
  side of the same shape).
- `InventoryStore.seedOnHand(sku, qty)` — **additive** method on the Phase-0 port; create-if-
  absent initial stock write (§8 Risk 4). Called once by the commerce upsert use-case on
  first creation of a `product_commerce` row.

**New REST endpoints (`@urumi/service`) — 1:1 with the port:**
- `PUT  /products/:id/commerce` → `ProductCommerceStore.upsert` (`Idempotency-Key` header);
  on first creation, also calls `InventoryStore.seedOnHand` (§8 Risk 4) — a single additional
  create-if-absent write, not a new endpoint.
- `GET  /products/:id/commerce` → `.getByProductId` (Phase 2 consumes this).
- `DELETE /products/:id/commerce` → `.softDelete` (soft, not hard).
- Empty/missing id → 400 `MISSING_PRODUCT_ID`; zod-validated bodies; money as integer minor
  units + currency on the wire (no floats in JSON — send integer + ISO-4217 string).

**How the contract suite extends.** Add `productCommerceStoreContract(makeStore,{dialect})`
alongside `inventoryStoreContract`. It runs against: (1) the in-memory fake, (2)
`store-postgres` on SQLite, (3) `store-postgres` on Postgres, and (4) — same cases — the
**live HTTP server** via `HttpCommerceClient`, proving wire ⇄ port fidelity. A new adapter is
"done" the day it turns this suite green (DEVELOPMENT.md §1). No new concurrency test (product-
commerce is not a race surface; the no-oversell invariant remains inventory-only).

---

## 8. Risks & open questions

1. **Content revision field for the idempotency key (ambiguous).** `emdash: ContentHookEvent`
   exposes `{ content, collection, isNew }`; the exact stable revision/`updatedAt` field on
   `content` for deriving a replay key isn't pinned in the platform notes. **Resolution:**
   confirm the content metadata shape in `~/em-dash` collection/content types; if no stable
   revision id, fall back to a hash of the commercial-relevant subset + `product_id`. Blocks
   Step 7's key derivation — resolve before it.
2. **`afterSave` durability without plugin-side atomic storage.** The sandbox has no CAS /
   durable queue (`emdash: ctx.storage` is unconditional upsert; uniqueness dropped). A hook
   that fails to reach the service can silently lose a sync until reconcile. **Resolution:**
   make reconcile-cron a first-class part of the phase (Step 9), and make the service upsert
   fully idempotent so replay is safe. Recommend landing the cron in Phase 1.
3. **Hook delivery guarantees / ordering.** Notes don't state whether `afterSave` /
   `afterPublish` are at-least-once, ordered, or fire-and-forget beyond "afterPublish is
   fire-and-forget" (`emdash: hooks.ts`). **Resolution:** design the upsert to be
   order-independent and idempotent (already the plan); treat all hooks as best-effort +
   cron-backed. No assumption of exactly-once.
4. **Where does initial stock live? (explicit recommendation, resolving the scope
   contradiction).** §2 says Phase 1 doesn't touch `inventory`, yet the panel offers a stock
   field. **Decision: Phase 1 writes the initial `inventory.on_hand` row, once, through a
   dedicated create-if-absent method — the panel field does not defer to Phase 3.**
   Mechanism, chosen to avoid the race Reviewer feedback correctly flagged (a blind
   `SET on_hand = :n` could clobber a concurrent decrement from Phase 3's `reserve`/`adjust`):
   - Add `InventoryStore.seedOnHand(sku, qty): Promise<void>` as an **additive** method on the
     Phase-0 port (mirrors how Phase 3 later adds `adjust` — a method addition, not a new
     adapter; Phase 0's `reserve`/`commit`/`release` are untouched).
   - Implementation is a single-statement, portable, **create-only** write:
     `INSERT INTO inventory (sku, on_hand) VALUES (:s, :q) ON CONFLICT (sku) DO NOTHING`. If a
     row already exists (a later re-save of the same product, or Phase 3 has already reserved
     against it), the insert is a no-op — it can **never** overwrite a live `on_hand`, so it
     cannot race or clobber a concurrent `reserve`/`adjust`.
   - The commercial upsert flow (Step 4/7) calls `seedOnHand` once, only on first creation of
     the `product_commerce` row (i.e. when the incoming `product_id` had no prior row); it is
     never called on a subsequent edit, matching the panel field's create-only UX (§5).
   - New contract case: `"seeding on_hand for a new sku creates the row once; re-seeding an
     existing sku (or a sku already decremented by a reserve) is a no-op and does not clobber
     the current on_hand"` — added to `inventoryStoreContract` alongside the Phase-3 `adjust`
     cases, run against fake · SQLite · Postgres (not concurrency-gated; the guard is
     `ON CONFLICT DO NOTHING`, not a race target on its own, though the "does not clobber an
     already-decremented row" case should still run after a `reserve` in the same test).
   - **`seedOnHand` intentionally carries no `idempotencyKey`** — the deliberate exception to
     CLAUDE.md's "every command carries an idempotency key." Its natural key is the `sku`
     (`inventory.sku` PK) and the `ON CONFLICT (sku) DO NOTHING` guard **is** the idempotency:
     a replay is structurally a no-op, so a separate key would add nothing to enforce. Documented
     here so the rule stays honest rather than silently bent.
   - **Restock / adjust-stock after first save is explicitly out of scope for Phase 1.** Because
     `seedOnHand` is create-only, nothing in Phase 1 lets a merchant *change* `on_hand` once the
     row exists (Phase 3's `adjust` moves reservation quantity, not on-hand; it is not a restock
     path). This is a known gap across the current plan set (Reviewer A NEW-4). **Recommended
     landing: a small additive, guarded `InventoryStore` restock method (e.g.
     `setOnHand`/`restock`, a single guarded write, contract-tested) behind an admin
     inventory-adjust endpoint in Phase 7's admin surface** (where merchant admin controls and
     the low-stock report already live) — flagged there, not built here. Called out so a fresh
     engineer sees the deferral is intentional, not an omission.
5. **Widget → route plumbing under Block Kit.** Whether a Block Kit action can post directly to
   a plugin route with the edited field payload (vs. needing an intermediate) isn't fully
   pinned. **Resolution:** validate the action→route round-trip in the Step-1 harness before
   Step 8; if Block Kit actions can't carry arbitrary payloads, the route reads current field
   state via `content:read`.
6. **`permanent` delete vs soft-delete retention.** `emdash: ContentDeleteEvent.permanent`
   distinguishes trash from hard delete. **Resolution (recommend):** always soft-delete in
   commerce (order history integrity); add a retention/purge policy later — do **not** hard-
   delete commercial rows in Phase 1.

---

## 9. Definition of done

- [ ] `productCommerceStoreContract` **green on both dialects** (SQLite + Postgres) — the
      contract suite is the spec.
- [ ] The **same cases green against the live HTTP server** via `HttpCommerceClient`
      (wire ⇄ port fidelity; no drift).
- [ ] Headline sandbox tests green **under workerd-on-Node** (not trusted in-process):
      afterSave upsert, replay-once, afterDelete soft-delete, create-then-price reject,
      afterSave-failure-does-not-throw.
- [ ] Block Kit "Product data" widget (no React) + create-then-price disabled state + save
      route green.
- [ ] **Sandbox-clean guard green:** manifest declares only `content:read` + `network:request`
      with `allowedHosts`; no storage/DB/other egress surface (CI check).
- [ ] `@urumi/domain` still imports **nothing with IO** — dependency-boundary lint green.
- [ ] Money is integer minor units + currency everywhere; the branded-`Cents` negative
      type-test fails to compile as expected.
- [ ] Migration is **forward-only**; `product_commerce` PK = CMS content id.
- [ ] `InventoryStore.seedOnHand` contract case green on every dialect: creates `on_hand` once
      for a new SKU; re-seeding an existing (or already-decremented) SKU is a no-op that never
      clobbers the current `on_hand` (§8 Risk 4).
- [ ] `pnpm lint` clean · `pnpm typecheck` clean · `pnpm format` (oxfmt, tabs) applied ·
      `pnpm test` green (SQLite) and `test:pg` green in CI.
- [ ] **Changeset added** (published packages changed: `@urumi/domain`, `@urumi/store-postgres`,
      `@urumi/service`, `@urumi/plugin`).
- [ ] PR tags per CLAUDE.md area (`[Domain]` / `[Adapters]` / `[Service]` / `[Plugin]`);
      one PR = one thing; passing runs recorded in the PR. **Never push to `main`** — merge is
      user-gated.

---

## 10. Revision log (post-approval review fold-in)

- **`idempotency_key` semantics self-contradictory: per-row "last applied" vs. described as
  globally unique (Reviewer A should-fix, Reviewer B should-fix).** Resolution: picked
  per-row, non-unique, compare-on-write semantics explicitly (§4); clarified the schema table
  (`NOT unique`), added an explicit "resolving the ambiguity" paragraph distinguishing this
  from Phase 0's global-`UNIQUE` reservations pattern, and fixed Step 4's contradictory
  "unique idempotency_key semantics" wording.
- **Initial-stock write vs. "Phase 1 does not touch inventory" ambiguity (Reviewer A
  should-fix, Reviewer B should-fix).** Resolution: made an explicit choice — Phase 1 *does*
  write `inventory` once, via a new additive, create-if-absent
  `InventoryStore.seedOnHand(sku, qty)` method (`INSERT … ON CONFLICT (sku) DO NOTHING`),
  called only on first creation of a `product_commerce` row. This can never clobber a
  concurrent `reserve`/`adjust` (Reviewer B's race concern) because it never overwrites an
  existing row. Updated §2 scope, the panel field description (§5, now explicitly create-only/
  read-only-after), Risk 4, §7's new service surface, and added a required contract case +
  DoD item.
- **Money-column naming drift, `price_amount` vs. the `_cents` convention (Reviewer A nit,
  Reviewer B cross-phase should-fix, CP-1/C1/C4).** Resolution: renamed the schema column and
  all prose references from `price_amount` to `price_cents`, per the convention now stated in
  Phase 0 §6.
- **Port method-name drift, `get(productId)` vs. `getByProductId` used elsewhere (Reviewer A
  nit, Reviewer B nit).** Resolution: renamed the `ProductCommerceStore` port method to
  `getByProductId` everywhere in this plan (schema-adjacent prose, §3, §7, the REST endpoint
  table) so it matches how Phase 2 already refers to it — single-sourced now.
- **Round 2 — `seedOnHand` carries no `idempotencyKey`, and no restock path exists after first
  save (Reviewer A NEW-4 should-fix; Reviewer B New-4 nit).** Resolution: documented in Risk 4
  that `seedOnHand`'s create-if-absent `ON CONFLICT (sku) DO NOTHING` guard **is** its
  idempotency (natural key = `sku`), the deliberate exception to "every command carries a key";
  and added a short paragraph acknowledging that restock/adjust-stock after first save is
  intentionally out of scope for Phase 1, recommending it land as a small additive guarded
  `InventoryStore` restock method behind an **admin inventory-adjust endpoint in Phase 7's admin
  surface** (Phase 3's `adjust` moves reservation qty, not on-hand). Flagged, not built here.
- **Risks 1, 2, 3, 5, 6 — no change.** Reviewed against both reports; no should-fix or nit was
  raised against the content-revision-key spike gate, reconcile-cron durability story, hook
  ordering assumption, widget→route plumbing spike, or soft-delete-on-permanent-delete
  recommendation. Kept as-is.
