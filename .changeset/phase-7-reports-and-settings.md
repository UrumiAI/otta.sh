---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Phase 7 — reports / settings / polish (the final planned phase). Adds merchant
visibility and control WITHOUT any new money-moving surface: reporting is
strictly read-only, and settings prove a three-tier split (plugin `ctx.kv` for
non-secret display prefs, the commerce store for operational config the domain
depends on, deployment env for secrets). The two disciplines this phase enforces:
revenue
aggregates stay integer `Cents` (never floats), and secrets never leak into
`ctx.kv` or any settings response body.

- `@otta-sh/domain`: two new IO-free ports — `ReportingStore` (revenue-by-period,
  orders-by-status, top-products, low-stock) and `SettingsStore` (get/update with
  the uniform `idempotencyKey`) — each with an in-memory fake, a reusable contract
  suite, and thin use-cases. Revenue counts an explicit ALLOW-LIST of states
  (`paid`/`processing`/`shipped`/`delivered`/`completed`) — not an
  exclude-cancelled/refunded list — shared by revenue and top-products so
  "revenue" means one thing; top-products uses the `order_items` price/title
  SNAPSHOT (never a live product join, Phase-4 rule). A `MAX_REPORT_RANGE_DAYS`
  (400) guard rejects unbounded ranges. A shared deterministic fixture (14 orders,
  all ten states, 2 currencies, 4 products) is the single source of truth for both
  the fake and the adapter tests.
- `@otta-sh/plugin`: an admin Reports Block Kit page (four report sections, each
  failing closed with an error banner) and a Settings form with two visible save
  paths — `storeDisplayName` via `ctx.kv` and the operational fields via the
  settings write, which is idempotency-keyed and validated rather than clamped,
  surfacing its validation error inline. A security test asserts that no
  secret-shaped field ever appears in a settings read. `ctx.kv` is added to the
  plugin context (ungated per EmDash); capabilities stay exactly `content:read`
  + `network:request` — no storage/db/kv capability, proven under the
  workerd-on-Node sandbox.
