# Phase 7 — Reports / settings / polish

_Implementation plan (no code). Principal-engineer sequencing for Phase 7 of Urumi._

> Governing rule (DEVELOPMENT.md §1, CLAUDE.md): **failing test → code → green → refactor.**
> For anything landing in `@urumi/domain`, the behavioral test is written against the **port**
> before any adapter. Real databases only — SQLite locally, Postgres in CI, per-test schema
> isolation. The plugin surface (the reporting widget + settings form) is proven under the
> **workerd-on-Node sandbox**, Block Kit only, egress only via `ctx.http` + `allowedHosts`.

This phase assumes Phases 0–6 are done: a full commerce service (inventory, products, cart,
checkout, orders, customers, totals engines for shipping/tax/coupons) plus a sandbox-clean
plugin with storefront routes and the "Product data" panel.

---

## 1. Goal & headline test

**Goal.** Give merchants visibility and control without adding new money-moving surface:
(a) an **admin Block Kit reporting page** in the plugin that reads pre-computed aggregates
over seeded orders/inventory via `ctx.http`, and (b) a **settings** story that puts each
config value in the right tier — plugin `ctx.kv` for non-secret display/UX preferences,
service env for secrets, service DB for non-secret operational config the domain logic
depends on. Reporting is **read-only** — it introduces no new domain invariant on par with
no-oversell or idempotent commit; the discipline this phase adds is: (1) aggregates stay
integer `Cents`, never floats, and (2) secrets never leak into `ctx.kv` or any settings
response body.

**Headline behavioral cases (write-first):**

1. **Correct aggregates over seeded orders (the phase's named headline test).** Given a
   deterministic seed of orders (fixed `createdAt`s, statuses, currencies, line items), the
   reporting queries return **exactly** the hand-computed expected values:
   - revenue-by-period sums `order_totals.total_cents` (the Phase-6-authoritative total; joined
     from `orders` on `order_id`) for orders in the revenue-counting states —
     `paid`/`processing`/`shipped`/`delivered`/`completed`, an allow-list that excludes
     `pending`/`failed`/`expired`/`cancelled`/`refunded` — into the correct period bucket,
     **grouped by currency**, as an integer — never drifts under a property test with
     randomized large cent amounts.
   - orders-by-status returns the exact count per `orders.state` for the seeded window,
     including `expired`.
   - top-products ranks by revenue (or quantity, per `metric` param) using the order-item
     **price/title snapshot** (never a live product join — Phase 4's snapshot rule), limited
     to `limit`.
   - low-stock returns exactly the SKUs with `on_hand <= threshold`, ascending by `on_hand`.
2. **Dialect parity.** All four aggregates are produced by the **same** `ReportingStore`
   contract suite run against SQLite (dev/local) and Postgres (CI) — no dialect-only
   behavior, no dialect-only rounding.
3. **Settings tiering is enforced, not just documented.** A settings round-trip test asserts:
   a non-secret operational field (e.g. `holdTtlMinutes`) persists via the service DB and is
   readable via `GET /settings`; a plugin-only display field (e.g. store display name)
   round-trips via `ctx.kv.put`/`ctx.kv.get` **without ever calling `ctx.http`**; and a
   negative test asserts no Stripe/x402/DB-credential field is reachable from `ctx.kv` or
   from any `/settings` response body.
4. **Validation, not silent clamping.** `PUT /settings` with an invalid operational value
   (e.g. `holdTtlMinutes <= 0`, non-integer `lowStockThreshold`) returns a `400` with a
   structured validation error — it is never silently clamped or coerced (no
   status-code-as-logic, adapter-architecture rule #2).
5. **Sandbox-clean proof.** The reporting widget and settings form run under the
   **workerd-on-Node sandbox**; both fail closed (render an error block, never throw into the
   host) when `ctx.http` errors, and both declare **only** `network:request` (`allowedHosts`
   = the commerce service host) + `kv` — no other capability, no DB/storage surface.

---

## 2. Scope

**In scope — a minimal v1 report set, four reports only:**
- **Revenue over period** — total order revenue bucketed by day/week/month, grouped by
  currency, excluding cancelled/refunded orders.
- **Orders by status** — count of orders per status over a period.
- **Top products** — ranked by revenue or quantity (selectable), over a period, using
  order-item snapshots.
- **Low stock** — SKUs at or below a threshold (global setting, overridable by query param).

**Settings v1 — three fields moved end-to-end to prove the tiering, not an exhaustive
settings catalog:**
- `holdTtlMinutes` (service DB — already read by Phase 3's cart hold-expiry cron; this phase
  makes it *editable* rather than hardcoded).
- `lowStockThreshold` (service DB — feeds the low-stock report's default).
- `storeDisplayName` (plugin `ctx.kv` — cosmetic only, used to label the reporting widget and
  any future storefront chrome).

**Explicitly out of scope / deferred:**
- **Dashboards / charts.** Block Kit ships text, section, and table-like elements, not a
  charting primitive — the widget renders numbers and tables, not graphs. A graphical
  dashboard is a future trusted-React admin surface, not this phase.
- **Exports** (CSV/JSON download, scheduled/emailed reports) — no export endpoint this phase.
- **Materialized/cached aggregates** — v1 computes on read; no rollup tables, no cron
  precomputation. Revisit if order volume makes on-read aggregation too slow (see Risks §8.3).
- **Per-product low-stock overrides** — v1 has one global threshold; per-SKU reorder points
  are a follow-on.
- **Admin stock restock/adjust — flagged addition, recommended to land in this phase's admin
  surface.** Phase 1's `seedOnHand` is create-only and Phase 3's `adjust` moves *reservation*
  qty, so no plan currently lets a merchant change `on_hand` after first save — yet this phase
  ships a low-stock report with no way to act on it (Reviewer A NEW-4). Recommended: a small
  additive, guarded `InventoryStore` restock method (single guarded write, contract-tested)
  behind an admin inventory-adjust endpoint alongside the low-stock report. Flagged here as the
  natural home (admin surface); scope it explicitly if picked up, as it is not in the current
  DoD.
- **Full settings catalog** (tax/shipping config surfaced as settings, email templates,
  customer-auth config) — only the three fields above move this phase; the *pattern*
  (kv vs. service-DB vs. env) generalizes to the rest later without new plumbing.
- **Settings audit trail** (who changed what, when) — noted as an open question (§8.8), not
  built this phase beyond a plain `updated_at`.
- **Multi-currency conversion/rollup** — reports never blend currencies into one number; a
  single-currency store just gets one group, by construction.

---

## 3. Dependencies

**Reused from Phases 0–6:**
- `@urumi/domain` — the ports directory + port-first contract-suite convention, the
  in-memory-fake pattern, and the branded `Cents`/`Currency` types (Phase 0 §0.2–0.3).
  Reporting and settings **add** two new ports (`ReportingStore`, `SettingsStore`) alongside
  `InventoryStore`/`OrderStore`/`ProductCommerceStore`.
- `@urumi/store-postgres` — the Kysely dialect-parameterized store, forward-only migrations,
  and the `describeEachDialect`-style contract wrapper (Phase 0 §0.4, reused verbatim by
  Phase 1's `productCommerceStoreContract`). Phase 7 adds two migrations (`settings` table;
  confirm indices on `orders`/`order_items`/`inventory` — see §4) and two adapters.
- `@urumi/service` — the Hono-style REST app, zod validation, `Idempotency-Key` header
  convention, no-status-code-as-logic rule, and the live-server HTTP-contract-test harness
  (Phase 0 §0.6, reused by Phase 1 §7). Phase 7 adds `/reports/*` and `/settings` endpoints.
- **Orders / order_items / order_totals schema — per Phase 4's "Canonical order schema
  (authoritative for Phases 5–7)"**: `orders` carries **no money column** — only `id`,
  `currency`, `state` (`pending`/`paid`/`failed`/`expired`, extended by Phase 5 with
  `processing`/`shipped`/`delivered`/`completed`/`cancelled`/`refunded`), `created_at`.
  `order_items` (insert-once snapshot) has `title`, `unit_price_cents`, `currency`,
  `quantity` — **never** `title_snapshot`/`qty`. **`order_totals`** (1:1 with `orders`,
  `order_id` PK, written once) is the **sole, authoritative home for every totals figure**
  (`subtotal_cents`, `discount_cents`, `shipping_cents`, `tax_cents`, `total_cents`,
  `currency`) — Phase 4 writes a stub (`total_cents = Σ(unit_price_cents × quantity)`),
  Phase 6 overwrites the same row with the real discount/shipping/tax figures. Phase 7's
  revenue report reads `order_totals.total_cents`, **never** a column on `orders` (which has
  none) and never a pre-Phase-6 stub.
- **Inventory schema (Phase 0/3)** — `inventory.sku`, `inventory.on_hand` for the low-stock
  report.
- **The cart hold-expiry cron (Phase 3)** — today reads a hardcoded `holdTtlMinutes`; this
  phase's `SettingsStore` becomes its source of truth, so the cron starts reading a value the
  merchant can change without a deploy.
- `@urumi/plugin` — the Block Kit widget infra and workerd-on-Node sandbox test harness
  established in Phase 1 (`fieldWidget` pattern) — Phase 7 uses the sibling `admin.pages` /
  `admin.widgets` / `admin.settingsSchema` surfaces with the **same** sandbox harness, and the
  same `HttpCommerceClient`-via-`ctx.http` discipline (no new transport pattern).
- **Provides nothing forward** — Phase 7 is the last phase in the build order; no downstream
  phase depends on it.

---

## 4. Reporting design

### 4.1 Where reporting lives (the domain-purity decision)

**Decision: reporting gets a real port, `ReportingStore`, in `@urumi/domain` — not a
service-layer-only query module.** Justification against the domain-purity rule
(CLAUDE.md non-negotiables, DEVELOPMENT.md §3):

- Domain purity is about **IO**, not about read-vs-write. A port that expresses "give me
  revenue bucketed by period" is exactly as IO-free as `InventoryStore.reserve` — the actual
  SQL lives in the adapter, not the port.
- Keeping it behind a port is what buys the **dialect-parity contract test** this phase's
  headline test requires (SQLite + Postgres, same suite) — mirroring
  `inventoryStoreContract`/`productCommerceStoreContract` rather than inventing a bespoke
  service-only test story.
- ADR-0002's whole bet is that `@urumi/domain` is the artifact that runs unchanged whether
  wired to `store-postgres` today or an in-process `EmdashStore` later. A reporting query
  that only exists as service-layer SQL would be the one piece that doesn't survive that
  swap. A `ReportingStore` port keeps reporting inside the same bet.
- **Accepted cost:** an extra layer of indirection for what is "just" read queries — a use-
  case (`getRevenueReport`, etc.) that does nothing but call the port and shape the result.
  This is deliberately thin; it exists for consistency and dialect-parity testing, not
  because reporting needs business-rule orchestration.
- **Rejected alternative:** a `ReportingQueries` class living directly in `@urumi/service`
  atop the existing Kysely instance, tested via `describeEachDialect` without going through
  a domain port. Simpler, less indirection — but it quietly special-cases reporting outside
  the pattern every other store follows, and forfeits the "same code runs in-process later"
  property. Not chosen; revisit only if the port genuinely turns out to be dead weight after
  landing it (note in retro, don't relitigate mid-implementation).

`SettingsStore` gets the same treatment for the same reason: Phase 3's hold-expiry cron is
domain logic that needs `holdTtlMinutes`, so it must reach it through a port, not an
environment variable or a raw service-layer query.

### 4.2 Aggregate queries (integer minor units in, integer minor units out)

All four queries run against Postgres and SQLite unchanged in shape; the **money and quantity
columns are integers on both dialects** (`order_totals.total_cents`, `order_items.unit_price_cents`,
`order_items.quantity`, `inventory.on_hand`) so `SUM()`/`COUNT()` stay integers. The known
SQLite footgun: dynamic typing means a column that was ever written as a float would make
`SUM()` return a float — mitigated by (a) these columns are populated exclusively by earlier
phases' branded-`Cents` writes, never by app code doing float math, and (b) a property test in
the contract suite asserts `SUM` of a large randomized set of integer cents equals the exact
expected integer, on both dialects.

**Which orders count as revenue.** Per Phase 4's state machine (`pending`/`paid`/`failed`/
`expired`) as extended by Phase 5 (`processing`/`shipped`/`delivered`/`completed`/`cancelled`/
`refunded`), an order represents **realized revenue** only once payment has actually been
confirmed and has not been reversed. That is an **allow-list**, not a "subtract the obviously
bad ones" exclusion — an exclusion list silently counts *every future status* as revenue by
default, which is exactly the kind of drift this phase's schema mismatch already demonstrated
once. **Revenue-counting states: `paid`, `processing`, `shipped`, `delivered`, `completed`.**
Excluded, explicitly: `pending` (no payment captured yet), `failed` (payment never succeeded),
`expired` (hold TTL passed unpaid — Phase 4's sweep already released the reservation),
`cancelled` (no realized sale), and `refunded` (money returned — netting refunds into revenue
is a v1.1 concern, out of scope here per §2). Both the revenue-over-period and top-products
queries use this same allow-list so "revenue" means one thing across the whole report set.

**Revenue basis (labelled explicitly).** Revenue-over-period buckets on **`orders.created_at`
(order-creation time), not payment-settlement time**, and sums the **net** order total
`order_totals.total_cents` (post-discount, incl. shipping + tax — the Phase-6-authoritative
figure). Top-products, by contrast, sums **gross item revenue** (`quantity × unit_price_cents`,
no discount/shipping/tax allocated — per-line discount is not stored on `order_items`). Same
revenue-counting state allow-list, but two deliberately different value bases and — for revenue
— a `created_at` time basis; each is labelled at its query and in the widget so merchants don't
reconcile the two figures and file a bug. (Bucketing on `created_at` is a v1 choice; switching
to a settled-at basis is a named follow-on if merchants want cash-basis reporting.)

**Revenue over period** (grouped by currency; revenue sourced from the Phase-6-authoritative
`order_totals`, never a column on `orders` — `orders` carries no money column; bucketed on
`orders.created_at`):
```sql
SELECT ot.currency,
       <dialect-bucket(o.created_at, :interval)> AS bucket,
       SUM(ot.total_cents) AS revenue_cents
FROM orders o
JOIN order_totals ot ON ot.order_id = o.id
WHERE o.created_at BETWEEN :from AND :to
  AND o.state IN ('paid', 'processing', 'shipped', 'delivered', 'completed')
GROUP BY ot.currency, bucket
ORDER BY bucket;
```
`<dialect-bucket>` is the one piece of dialect-specific SQL in this phase (Postgres
`date_trunc(:interval, created_at)` vs. SQLite `strftime(<fmt for :interval>, created_at)`).
It lives entirely inside the `store-postgres` adapter behind a small `truncateToInterval`
helper — the port and the contract-suite assertions are dialect-agnostic; only the adapter
branches on dialect, same pattern as the rest of `store-postgres`.

**Orders by status** (reports on `orders.state` — the actual column Phase 4 defines; the
report's external vocabulary stays "status" since that is the merchant-facing term, but the
adapter reads `state`; no exclusion here — every state, including `expired`, is a real bucket
merchants need visibility into):
```sql
SELECT state, COUNT(*) AS order_count
FROM orders
WHERE created_at BETWEEN :from AND :to
GROUP BY state;
```

**Top products** (metric is **gross item revenue** — `quantity × unit_price_cents`, no
discount/shipping/tax — labelled as such in the report; uses the order-item price/title
**snapshot**, per Phase 4's immutability rule, so a renamed/deleted product still reports
correctly against historical orders; same revenue-counting allow-list as above, applied via
`orders.state`):
```sql
SELECT oi.product_id, oi.title,
       SUM(oi.quantity) AS qty_sold,
       SUM(oi.quantity * oi.unit_price_cents) AS revenue_cents
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.created_at BETWEEN :from AND :to
  AND o.state IN ('paid', 'processing', 'shipped', 'delivered', 'completed')
GROUP BY oi.product_id, oi.title
ORDER BY (CASE WHEN :metric = 'quantity' THEN qty_sold ELSE revenue_cents END) DESC
LIMIT :limit;
```

**Low stock** (threshold defaults from `SettingsStore.lowStockThreshold` when the query param
is omitted; unchanged — `inventory` schema is Phase 0/3's, not part of this revision):
```sql
SELECT sku, on_hand
FROM inventory
WHERE on_hand <= :threshold
ORDER BY on_hand ASC;
```

**Indices to confirm/add** (migration, forward-only): `orders(created_at, state)`,
`order_items(order_id, product_id)`, `inventory(on_hand)` — cheap insurance against full
scans as order volume grows; not a performance target this phase, just don't regress.
`order_totals` needs no extra index for this phase's join — its PK is `order_id`, which is
exactly the join key from `orders`.

**Report date-range cap (promoted into this phase — see Revision log).** `/reports/*` reject
`from`/`to` ranges wider than **400 days** with a `400` and a structured validation error,
same "validation not silent clamping" discipline as `/settings`. This is a service-side
guarantee, not merely a plugin-side UX default — the endpoints are public service surface and
an unbounded range is an unbounded scan regardless of what the admin widget's date picker
allows.

### 4.3 Seeded-data test fixtures

A deterministic fixture (fixed `Clock`, fixed ids, explicit list — not `Math.random`) shared
between the contract suite and the headline seeded test: N orders (recommend ~14, up from ~12
to fit the full state set below) spanning 3 days, with **every one of the ten Phase-4/5 order
states represented at least once** — `pending`, `paid`, `processing`, `shipped`, `delivered`,
`completed`, `cancelled`, `failed`, `expired`, `refunded` — so the revenue report's allow-list
(§4.2: `paid`/`processing`/`shipped`/`delivered`/`completed`) is proven against **every excluded
state**, not just `cancelled`. Each order has a matching `order_totals` row (per Phase 4/6, the
one authoritative totals write); the hand-computed expected revenue is the sum of `total_cents`
over **only** the five revenue-counting orders — the fixture must make this sum differ from
"sum over everything" and from "sum excluding only cancelled/refunded," or the test cannot
distinguish a correct allow-list from the old, wrong exclusion-list logic. 2 currencies (to
prove grouping), 4 distinct products with known per-line quantities/prices, and inventory rows
straddling the low-stock threshold (some above, some at, some below). Fixture lives once in a
shared test-utils location (mirrors the in-memory-fake convention) so both the in-memory-fake
use-case tests and the dialect contract tests assert against the **same** hand-computed expected
numbers — no drift between what's "designed" and what's "seeded."

### 4.4 REST endpoints + admin widget consumption

`@urumi/service` exposes one endpoint per report, 1:1 with the port (§6). The plugin's Reports
page (`admin.pages`) calls each endpoint over `ctx.http` via the existing `HttpCommerceClient`
pattern (no new transport primitive), with a date-range control (default: trailing 30 days,
UTC bucketing — see Risks §8.6) and renders each report as a Block Kit section/table. The
plugin-side default/max is a UX nicety only, not the enforcement boundary: the service itself
rejects a `from`/`to` range wider than 400 days with a `400` (§4.2) — the plugin's date picker
and the service's cap are independent layers, and the service one is the actual guarantee. A
compact low-stock count on the main admin dashboard (`admin.widgets`) is a nice-to-have,
explicitly **not** required for this phase's definition of done (keep the v1 surface to the
one Reports page).

---

## 5. Settings design

### 5.1 The three-tier split (recommended, and why)

| Tier | Holds | Examples this phase | Reachable by |
| --- | --- | --- | --- |
| Plugin `ctx.kv` | Non-secret, **display-only**, never read by domain logic | `storeDisplayName` (widget/label cosmetics) | Plugin sandbox only; service never reads it |
| Service DB (`settings` table) | Non-secret, **operational** — a value domain use-cases depend on | `holdTtlMinutes`, `lowStockThreshold` | `SettingsStore` port → service `/settings` endpoint |
| Service env | **Secrets** | Stripe secret key + webhook signing secret, x402 key material, DB connection string, session/JWT signing secret, SMTP credentials | Service process only; never serialized to any response |

**Why this split, not "kv for everything non-secret":** `ctx.kv` is plugin-sandbox storage —
the *service* never reads it, and (per the platform notes) it has no CAS/uniqueness guarantee
even for non-secret data. Anything the **domain** depends on for correctness (the cart
hold-expiry cron reading `holdTtlMinutes`, the low-stock report's default threshold) must be a
single source of truth the service can read directly and consistently, through a port like
every other piece of domain state — not fetched an extra hop away in plugin storage. `ctx.kv`
is reserved for values that are purely cosmetic/UX and never touch money or inventory logic.

**Why operational config is service-DB, not service env:** env vars require a deploy to
change; `holdTtlMinutes`/`lowStockThreshold` are exactly the kind of value a merchant should
be able to tune from the admin UI without a release. Secrets stay in env because they must
never be readable through any HTTP surface (including `/settings`) or copyable into
plugin-reachable storage — this is the same PCI/secret-isolation argument ADR-0002 gives for
keeping payments in the service at all.

### 5.2 `SettingsStore` port shape

`get(): OperationalSettings` (typed, with defaults if unset — never an error for "no row
yet") and `update(patch, idempotencyKey): OperationalSettings` (validated, partial update,
returns the full resulting settings). Applying the same idempotency discipline as every other
command in the domain (CLAUDE.md non-negotiables: "every command carries an
`idempotencyKey`") — low-frequency, single-admin usage makes races unlikely, but the rule is
applied uniformly rather than special-cased away; see Risks §8.5 for the case against.

### 5.3 Settings Block Kit form

One form, two save paths, made visible in the UI rather than hidden:
- **kv-backed fields** (`storeDisplayName`) save directly via `ctx.kv.put` — no network call,
  no service round-trip.
- **service-backed fields** (`holdTtlMinutes`, `lowStockThreshold`) save via
  `PUT /settings` over `ctx.http`, and surface the service's validation error inline
  (never swallowed into a generic "save failed").

Validation: zod schemas in `@urumi/service` for service-backed fields (`holdTtlMinutes`:
positive integer, sane upper bound e.g. ≤ 10080 minutes/1 week; `lowStockThreshold`:
non-negative integer); light plugin-side validation for the kv field (non-empty string,
length cap) since there's no service round-trip to catch it. `admin.settingsSchema` declares
the field shapes so the host renders reasonable input widgets.

---

## 6. New service surface

**New domain ports (`@urumi/domain`):**
- `ReportingStore { revenueByPeriod(range, interval), ordersByStatus(range), topProducts(range, metric, limit), lowStock(threshold) }`
  — intent only (period ranges, group keys), no SQL; the port signature does not encode which
  DB tables back it, but per §4.2 the adapter's `revenueByPeriod`/`topProducts` implementations
  join `orders`→`order_totals` and filter to the revenue-counting state allow-list
  (`paid`/`processing`/`shipped`/`delivered`/`completed`) — that filter is adapter SQL, not a
  port concern, but it is **one** filter shared by both queries, not reimplemented twice.
  Types: `PeriodBucket { bucketStart, currency, revenueCents }`,
  `StatusCount { status, orderCount }`, `TopProduct { productId, titleSnapshot, qtySold, revenueCents }`,
  `LowStockRow { sku, onHand }`. (These are the port's output field names, chosen for API
  readability; they are intentionally distinct from the underlying column names in §4.2 — the
  adapter is exactly where that mapping happens.)
- `SettingsStore { get(): OperationalSettings; update(patch, idempotencyKey): OperationalSettings }`
  — `OperationalSettings { holdTtlMinutes: number; lowStockThreshold: number }` (both plain
  non-money integers; no branded-money type needed here, but validated as positive/non-negative
  in the domain use-case, not just at the HTTP edge).
- Thin use-cases: `getRevenueReport`, `getOrdersByStatusReport`, `getTopProductsReport`,
  `getLowStockReport`, `getSettings`, `updateSettings` — orchestration only (default the
  low-stock threshold from settings when the caller omits it; reject invalid `updateSettings`
  input before it reaches the store).

**New REST endpoints (`@urumi/service`) — 1:1 with the ports:**
- `GET /reports/revenue?from=&to=&interval=day|week|month` → `revenueByPeriod`.
- `GET /reports/orders-by-status?from=&to=` → `ordersByStatus`.
- `GET /reports/top-products?from=&to=&metric=revenue|quantity&limit=` → `topProducts`.
- `GET /reports/low-stock?threshold=` (optional; defaults from `SettingsStore`) → `lowStock`.
- All three date-ranged endpoints (`revenue`, `orders-by-status`, `top-products`) zod-validate
  `to - from <= 400 days`; a wider range → `400` with a structured error, same validation
  discipline as `/settings` (§4.2's promoted date-range cap).
- `GET /settings` → `SettingsStore.get`.
- `PUT /settings` → `SettingsStore.update` (`Idempotency-Key` header); zod-validated body;
  invalid values → `400` with a structured error, never clamped.
- All money in report responses is serialized as **integer cents + ISO-4217 currency string**
  — no floats on the wire, same convention as every other endpoint (Phase 1 §7).

**How the contract suite extends.** Add `reportingStoreContract(makeStore, {dialect})` and
`settingsStoreContract(makeStore, {dialect})` alongside the existing store contracts. Each
runs against: (1) an in-memory fake (proves the suite/port shape before any DB), (2)
`store-postgres` on SQLite, (3) `store-postgres` on Postgres, and (4) the same cases against
the **live HTTP server**, proving wire ⇄ port fidelity (mirrors Phase 1 §7). No
Postgres-required concurrency test this phase — reporting/settings are not a race surface
(the no-oversell invariant remains inventory-only); a single settings-replay test (same
`idempotencyKey` twice → same result, no double-apply) is the only concurrency-adjacent case,
and it passes on both dialects.

---

## 7. Ordered red→green steps (TDD)

Each step: **named failing test first, then the minimum code to green.**

**Step 1 — `ReportingStore` + `SettingsStore` ports and fakes (contract-first).**
- Test: `packages/domain/test/reporting/reporting-use-cases.test.ts`:
  - `it("getRevenueReport sums order_totals.total_cents in Cents per period bucket, grouped by currency")`
  - `it("getRevenueReport counts only paid/processing/shipped/delivered/completed orders")`
  - `it("getRevenueReport excludes pending, failed, expired, cancelled, and refunded orders")`
  - `it("getOrdersByStatusReport counts orders per state for the period, including expired")`
  - `it("getTopProductsReport ranks products by revenue, limited to N, using the order_items title/unit_price_cents/quantity snapshot")`
  - `it("getTopProductsReport ranks by quantity when metric=quantity")`
  - `it("getTopProductsReport applies the same revenue-counting state allow-list as getRevenueReport")`
  - `it("getLowStockReport returns SKUs at or below threshold, ascending by on_hand")`
  - `it("getRevenueReport/getOrdersByStatusReport/getTopProductsReport reject a from/to range wider than 400 days")`
- Test: `packages/domain/test/settings/settings-use-cases.test.ts`:
  - `it("getSettings returns defaults when nothing persisted yet")`
  - `it("updateSettings persists holdTtlMinutes and lowStockThreshold")`
  - `it("updateSettings rejects holdTtlMinutes <= 0 before it reaches the store")`
  - `it("updateSettings rejects a non-integer lowStockThreshold")`
  - `it("updateSettings replayed with the same idempotencyKey does not double-apply")`
- Code: add `ReportingStore`/`SettingsStore` interfaces + result types to `@urumi/domain/ports`,
  the six/five thin use-cases above, and in-memory fakes in domain test-utils.
- Green when: all cases pass against the fakes.

**Step 2 — lift into shared contract suites.**
- Test: extract `reportingStoreContract(makeStore, {dialect})` and
  `settingsStoreContract(makeStore, {dialect})`, each carrying the same named cases as Step 1;
  run first against the in-memory fakes (proves the suites are real before any DB), mirroring
  Phase 0 §0.3 / Phase 1 §6 Step 3.
- Green when: both contracts pass against the fakes.

**Step 3 — `store-postgres` adapters on both dialects.**
- Forward-only migration: `settings` table (single row or key/value — recommend a single-row
  typed table, simplest for a handful of fields) with `hold_ttl_minutes`, `low_stock_threshold`,
  `updated_at`; confirm/add indices from §4.2 on `orders`/`order_items`/`inventory` (no new
  index needed on `order_totals` — its PK, `order_id`, is already the join key).
- Implement `ReportingStore` (the four SQL shapes in §4.2, with the `truncateToInterval`
  dialect-branch helper for the bucket expression) and `SettingsStore` (idempotent upsert on
  the single settings row) in `@urumi/store-postgres`.
- Test: `packages/store-postgres/test/reporting.contract.test.ts` and
  `packages/store-postgres/test/settings.contract.test.ts` run the Step-2 suites via the
  `describeEachDialect` wrapper — SQLite always, Postgres when `PG_CONNECTION_STRING` is set /
  in CI, per-test schema isolation.
- Green when: both contract suites pass on **both** dialects.

**Step 4 — the headline seeded-aggregate test.**
- Test: `packages/store-postgres/test/reporting.seeded.test.ts` →
  `it("reporting queries return correct aggregates over seeded orders")` — build the §4.3
  fixture (fixed clock/ids, ~14 orders/3 days/2 currencies/4 products, **all ten Phase-4/5
  order states represented**, inventory straddling the threshold), assert all four reports
  match hand-computed expected values exactly, on both dialects — in particular that revenue
  equals the sum of `order_totals.total_cents` over only the five revenue-counting states, not
  a sum over `orders` (which has no total column) and not "everything except
  cancelled/refunded." Include the randomized-cents property test for `SUM` integer fidelity
  (§4.2) in the same file.
- Green when: this test (the phase's named headline test) passes on SQLite and Postgres.

**Step 5 — service REST endpoints (wire ⇄ port fidelity).**
- Endpoints per §6, zod-validated, no status-code-as-logic.
- Test: `packages/service/test/reports-http.test.ts` and
  `packages/service/test/settings-http.test.ts` run the same behavioral cases (Steps 1/4)
  against a **live test server** backed by Postgres (Phase 0 §0.6 harness), plus:
  - `it("GET /reports/top-products respects metric and limit query params")`
  - `it("GET /reports/revenue with a from/to range over 400 days returns 400 with a structured validation error")`
  - `it("PUT /settings with holdTtlMinutes=0 returns 400 with a structured validation error")`
  - `it("GET /settings never includes a stripeSecretKey/dbUrl/webhookSecret field")` (negative
    test — greps the response body / asserts the response schema has no secret-shaped field).
- Green when: HTTP contract tests pass against a live server.

**Step 6 — Reports admin Block Kit page (sandbox).**
- Test: `packages/plugin/test/reports-widget.sandbox.test.ts`, run under the Step-1 sandbox
  harness established in Phase 1 (workerd-on-Node, not trusted in-process):
  - `it("Reports page renders revenue, orders-by-status, top-products, and low-stock sections via ctx.http only")`
  - `it("Reports page fails closed with an error block when ctx.http rejects, never throws")`
  - `it("Reports page manifest declares only network:request with allowedHosts, no other capability")`
- Code: `admin.pages` entry composing four Block Kit sections, each backed by one `/reports/*`
  call through the existing `HttpCommerceClient`.
- Green when: all three pass in the sandbox.

**Step 7 — Settings Block Kit form (sandbox).**
- Test: `packages/plugin/test/settings-widget.sandbox.test.ts`:
  - `it("storeDisplayName saves via ctx.kv.put without calling ctx.http")`
  - `it("holdTtlMinutes and lowStockThreshold save via PUT /settings over ctx.http")`
  - `it("a service-side validation error (400) surfaces inline on the form, not swallowed")`
  - `it("settings form manifest declares only kv and network:request (allowedHosts), no other capability")`
- Code: `admin.settingsSchema` + the form's two save paths.
- Green when: all four pass in the sandbox.

**Step 8 — (optional) Playwright/e2e.** CLAUDE.md's plugin verification policy calls for
Playwright + a screenshot "once storefront e2e exists" — this phase's surface is **admin**,
not storefront, so Playwright is not required for definition of done; the sandbox tests in
Steps 6–7 are the gate. Revisit only if a storefront e2e harness already exists and extending
it to admin pages is cheap.

---

## 8. Risks & open questions

1. **Reporting-as-a-port vs. service-layer-only queries.** Addressed as a decision in §4.1
   (port, for dialect-parity + future in-process merge). **Open:** if the extra indirection
   proves to be pure ceremony after landing it, note it in the phase retro rather than
   relitigating mid-implementation.
2. **Multi-currency revenue.** Recommendation (adopted in §4.2): never sum across currencies;
   group by currency always, even for a single-currency store (degenerates to one group). No
   FX conversion in v1.
3. **On-read aggregation at scale.** No materialized/cached rollups this phase (§2 scope). If
   order volume grows enough that `/reports/revenue` becomes slow, the fix is a rollup table
   fed by a cron — deliberately deferred; the indices in §4.2 are the only performance
   insurance taken now.
4. **Low-stock threshold: global vs. per-SKU.** v1 is one global `SettingsStore` value (§2).
   **Recommendation:** ship global-only; add a per-SKU override column on inventory only if a
   real merchant need appears — don't build it speculatively.
5. **Should `updateSettings` really require an idempotency key?** It's a low-frequency,
   single-admin action, unlike checkout/reserve. **Recommendation:** keep the idempotency
   discipline uniform (§5.2) — the cost is trivial (one header, one dedupe check) and it
   avoids a documented exception to a non-negotiable rule. If this turns out to add real
   friction to the settings-form UX, revisit as a scoped exception with its own note, not
   silently.
6. **Time-zone bucketing for revenue-by-period.** **Recommendation:** UTC bucketing in v1 (no
   store-timezone setting yet); note this in the widget's date-range UI so merchants aren't
   surprised by day-boundary placement. A `storeTimezone` setting is a natural v1.1 addition
   using the exact same kv/service-DB tiering decided here.
7. **Report widget date-range abuse (unbounded scans) — resolved this phase, not deferred.**
   Both reviews flagged that a plugin-side-only cap leaves `/reports/*` an unbounded scan on
   the wire (it's public service surface, reachable without the plugin). **Resolution:** the
   service itself now rejects `to - from > 400 days` with a `400` (§4.2, §6, §7 Steps 1/5) —
   the plugin's 30-day default/max is kept as a UX nicety on top, not the enforcement boundary.
8. **Settings audit trail.** Not built this phase beyond a plain `updated_at` column (§2).
   **Recommendation:** cheap insurance now is `updated_at`; add `updated_by` (once there's a
   notion of which admin/staff user made the change) only when that identity concept exists
   on the admin side — don't invent one here.
9. **Single-row vs. key/value shape for the `settings` table.** §7 Step 3 recommends a single
   typed row (simplest for ~2 fields today). **Open:** if the settings catalog grows well
   past the three fields in this phase, a key/value shape may age better — revisit if/when a
   fourth or fifth service-DB setting is added, don't over-generalize for two fields.

---

## 9. Definition of done

- [ ] `reportingStoreContract` and `settingsStoreContract` **green on both dialects** (SQLite
      + Postgres) — the contract suite is the spec.
- [ ] Revenue and top-products queries read `order_totals.total_cents` /
      `order_items.{title,unit_price_cents,quantity}` (the Phase-4 canonical schema) — **never**
      a money column on `orders` (it has none) and never `title_snapshot`/`qty`. Revenue counts
      only `paid`/`processing`/`shipped`/`delivered`/`completed` orders — an allow-list, not an
      exclude-cancelled/refunded list — verified by the seeded test against all ten states
      including `expired`.
- [ ] The **headline seeded-aggregate test** (`reporting queries return correct aggregates
      over seeded orders`) green on both dialects, including the randomized-cents property
      test proving no float drift.
- [ ] `/reports/revenue`, `/reports/orders-by-status`, `/reports/top-products` reject a
      `from`/`to` range wider than 400 days with a `400` + structured error (service-side, not
      only the plugin's client-side default/max).
- [ ] The **same cases green against the live HTTP server** for both `/reports/*` and
      `/settings` (wire ⇄ port fidelity; no drift).
- [ ] `PUT /settings` validation rejects bad input with `400` + a structured error — never
      silently clamped.
- [ ] Negative test passing: no secret-shaped field (`stripeSecretKey`, `dbUrl`,
      `webhookSecret`, etc.) is reachable from `ctx.kv` or from any `/settings` response body.
- [ ] Reports page and settings form pass their **sandbox tests under workerd-on-Node** (not
      trusted in-process): render via `ctx.http`/`ctx.kv` only, fail closed on error, correct
      two-path settings save (kv direct vs. service over `ctx.http`).
- [ ] **Sandbox-clean guard green:** both widgets' manifests declare only
      `network:request`(`allowedHosts`) + `kv` — no other capability, no DB/storage surface.
- [ ] `@urumi/domain` still imports **nothing with IO** — dependency-boundary lint green
      (`ReportingStore`/`SettingsStore` are interfaces only; all SQL lives in
      `store-postgres`).
- [ ] Money in every report stays integer minor units + explicit currency, on the wire and in
      the store — no float ever touches a revenue figure.
- [ ] Migration is **forward-only**; indices from §4.2 present.
- [ ] `pnpm lint` clean · `pnpm typecheck` clean · `pnpm format` (oxfmt, tabs) applied ·
      `pnpm test` green (SQLite) and `test:pg` green in CI.
- [ ] **Changeset added** for each published package touched (`@urumi/domain`,
      `@urumi/store-postgres`, `@urumi/service`, `@urumi/plugin`).
- [ ] PR tags per CLAUDE.md area (`[Domain]` / `[Adapters]` / `[Service]` / `[Plugin]`); scope
      discipline means this phase is likely **several PRs**, not one (ports+use-cases,
      adapters+migration, service endpoints, plugin widgets) — one PR = one thing; passing
      runs recorded in each PR. **Never push to `main`** — merge is user-gated.

---

## Revision log

Both reviews returned REQUEST CHANGES on this phase (Reviewer A §Phase 7 finding 1; Reviewer B
§Phase 7 finding 1 / cross-phase C1) for the same root cause: the reporting SQL targeted
columns that neither Phase 4 nor Phase 6 actually define. This revision aligns to the now-fixed
Phase 4 "Canonical order schema (authoritative for Phases 5–7)" subsection.

| # | Finding (both reviewers, blocker) | Resolution |
|---|---|---|
| 1 | `SUM(orders.total_cents)` — `orders` has no money column; the authoritative total lives on `order_totals` (Phase 6-populated), and pre-fix this would have read a non-existent column or a stale Phase-4 stub. | Revenue-over-period and top-products now `JOIN order_totals ot ON ot.order_id = o.id` and read `ot.total_cents`/`ot.currency`. `orders` is used only for `state`/`created_at` (§4.2, §3 Dependencies). |
| 2 | `order_items.title_snapshot`, `order_items.qty` — Phase 4 actually names these `title`, `quantity`. | Top-products query and its port-mapping note now read `oi.title`, `oi.quantity` (§4.2, §6). |
| 3 | "Excludes cancelled/refunded" is an exclusion-list, not a positive definition of revenue — it would have silently counted `pending`, `failed`, and `expired` orders (none of which were ever paid) as revenue, and doesn't reconcile with Phase 4's `expired` state at all. | Replaced with an explicit allow-list consistent with Phase 4/5's full state machine: revenue counts only `paid`/`processing`/`shipped`/`delivered`/`completed`. `pending`/`failed`/`expired`/`cancelled`/`refunded` are explicitly excluded, `expired` by name (§4.2). Same allow-list applied to top-products so "revenue" means one thing across both reports. Orders-by-status is unaffected (it counts every state, including `expired`, by design) but now reads `orders.state` (Phase 4's actual column) instead of a `status` column that doesn't exist on `orders`. |
| 4 | Seeded fixture (§4.3) only exercised `cancelled` as a negative case, which cannot distinguish a correct allow-list from the old, wrong exclusion-list. | Fixture expanded to include all ten Phase-4/5 states at least once (including `expired`, `refunded`, `pending`, `failed`), with hand-computed expected revenue that differs from both "sum everything" and "sum excluding only cancelled/refunded" (§4.3, §7 Step 4). |
| 5 | (Should-fix, Reviewer B) Unbounded `from`/`to` date range on public service surface — originally deferred to a plugin-side-only default/max. | Promoted into this phase: `/reports/*` now server-side reject a range wider than 400 days with `400` + structured error, same discipline as `/settings` validation (§4.2, §6, §7 Steps 1/5, DoD). Not deferred, since a plugin-side cap alone doesn't protect the service endpoint itself. |
| 6 | (Nit, Reviewer A) Settings table single-row vs. key/value shape (Risk §9 / old §8.9). | No change — already an explicitly-deferred open question with a stated revisit trigger ("fourth or fifth service-DB setting"); not a blocker, left as-is. |
| 7 | UTC bucketing (both reviewers noted it as honestly scoped, not a defect). | No change — already correctly documented as v1 scope with a named follow-on (`storeTimezone`, Risk §6); not something either review asked to fix. |

**Round 2 (re-review):**

| # | Finding (reviewer) | Resolution |
|---|---|---|
| R2-1 | **Revenue basis under-labelled** (Reviewer A NEW-5, nit) — "revenue means one thing" overstated: revenue-by-period is net `order_totals.total_cents` while top-products is gross line revenue, and the time basis was implicit. | Added an explicit **"Revenue basis (labelled explicitly)"** paragraph (§4.2): revenue-by-period buckets on **`orders.created_at`** (order-creation time, not settlement) and sums **net** total; top-products is labelled **gross item revenue** (`quantity × unit_price_cents`) at its query and in the widget, so the two figures aren't reconciled into a bug report. |
| R2-2 | **No admin restock/adjust-stock path exists across the plan set** (Reviewer A NEW-4, cross-phase, flagged from Phase 1) — this phase ships a low-stock report with no way to act on it. | Cross-referenced as a flagged addition in the deferred-scope list: a small additive guarded `InventoryStore` restock method behind an admin inventory-adjust endpoint in this phase's admin surface; flagged, not added to DoD unless picked up. Phase 1 Risk 4 recommends the same landing. |
