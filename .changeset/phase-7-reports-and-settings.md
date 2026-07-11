---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Phase 7 — reports / settings / polish (the final planned phase). Adds merchant
visibility and control WITHOUT any new money-moving surface: reporting is
strictly read-only, and settings prove a three-tier split (plugin `ctx.kv` for
non-secret display prefs, service DB for operational config the domain depends
on, service env for secrets). The two disciplines this phase enforces: revenue
aggregates stay integer `Cents` (never floats), and secrets never leak into
`ctx.kv` or any settings response body.

- `@urumi/domain`: two new IO-free ports — `ReportingStore` (revenue-by-period,
  orders-by-status, top-products, low-stock) and `SettingsStore` (get/update with
  the uniform `idempotencyKey`) — each with an in-memory fake, a reusable contract
  suite, and thin use-cases. Revenue counts an explicit ALLOW-LIST of states
  (`paid`/`processing`/`shipped`/`delivered`/`completed`) — not an
  exclude-cancelled/refunded list — shared by revenue and top-products so
  "revenue" means one thing; top-products uses the `order_items` price/title
  SNAPSHOT (never a live product join, Phase-4 rule). A `MAX_REPORT_RANGE_DAYS`
  (400) guard rejects unbounded ranges. A shared deterministic fixture (14 orders,
  all ten states, 2 currencies, 4 products) is the single source of truth for both
  the fake and dialect tests.
- `@urumi/store-postgres`: forward-only migration `0008_settings_and_reporting_indices`
  (single-row `settings` table + `settings_mutations` idempotency ledger; reporting
  indices on `orders(created_at,state)`, `order_items(order_id,product_id)`,
  `inventory(on_hand)`). `KyselyReportingStore` runs the four aggregates on
  better-sqlite3 + Postgres with one dialect-branched period-bucket helper
  (`date_trunc` vs `strftime`, both truncating `week` to the ISO Monday);
  `KyselySettingsStore` is an idempotency-ledgered upsert (a replay returns the
  recorded result and never clobbers a newer write). The shared contract suites,
  the headline seeded-aggregate test, and a randomized large-cents property test
  proving no float drift all pass on BOTH dialects.
- `@urumi/service`: read-only `/reports/{revenue,orders-by-status,top-products,
  low-stock}` (money as integer cents + ISO-4217 on the wire; the three ranged
  endpoints reject a >400-day window with a `400` + structured error), and
  `GET`/`PUT /settings` (`PUT` is a privileged admin write — internal token +
  `Idempotency-Key` — zod-validated, invalid values are a `400`, never clamped). A
  live-server HTTP contract test proves wire ⇄ port fidelity, plus a security test
  asserting no secret-shaped field ever appears in a `/settings` response.
- `@urumi/plugin`: an admin Reports Block Kit page (four report sections over
  `ctx.http`, fails closed with an error banner) and a Settings form with two
  visible save paths — `storeDisplayName` via `ctx.kv` (no service call) and the
  operational fields via `PUT /settings` over `ctx.http` (surfacing the service's
  validation error inline). `ctx.kv` is added to the plugin context (ungated per
  EmDash); capabilities stay exactly `content:read` + `network:request` — no
  storage/db/kv capability, proven under the workerd-on-Node sandbox.
