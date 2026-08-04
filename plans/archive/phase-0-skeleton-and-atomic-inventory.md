# Phase 0 — Service skeleton + atomic inventory

_Execution-ready plan. Derived from `draft-plans/implementation-plan.md` §0.1–0.6,
`draft-plans/adapter-architecture.md`, `draft-plans/component-map.md`,
`draft-plans/design-decisions.md`, ADR-0001, ADR-0002, and the non-negotiables in
`CLAUDE.md` / `DEVELOPMENT.md`. A fresh engineer should be able to execute this top to
bottom without re-deriving any decision._

**Status entering this phase:** pre-scaffold. Nothing exists in the workspace yet, so this
plan includes the full pnpm-workspace bootstrap. **Branch:** `feat/phase-0-atomic-inventory`
(or per-step `feat/<slug>` worktrees; see §5 sequencing). **PR tags:** `[CI]` for 0.1,
`[Domain]` for 0.2–0.3, `[Adapters]` for 0.4–0.5, `[Service]` for 0.6.

---

## 1. Goal & headline test

Stand up a running commerce service that can `reserve / commit / release` stock, wired
`@otta-sh/domain` → `@otta-sh/store-postgres` (Kysely) → `@otta-sh/service` (REST), with **zero
EmDash surface**, and prove the one property the entire two-part architecture rests on:
**no oversell under concurrency.** Money is modeled as branded integer minor units from day
one, the domain imports nothing with IO (enforced by lint), every command is idempotent,
and one reusable behavioral suite is green against every store adapter. Everything in
Phases 1–7 depends on this skeleton and this guarantee.

**Headline acceptance test (Postgres-required, the Phase-0 gate):**

> Seed a single SKU with `on_hand = M`. Fire `N` concurrent `reserve(sku, 1, uniqueKey_i)`
> calls (`N > M`, e.g. `M = 5`, `N = 50`) via `Promise.all`, **each on its own independent
> Postgres connection** (a real race, not serialized). Assert **exactly `M`** results are
> `{ ok: true }`, **exactly `N − M`** are `{ ok: false, reason: "OUT_OF_STOCK" }`, and
> final `on_hand == 0`. Runs only when `PG_CONNECTION_STRING` is set — `better-sqlite3`
> serializes writes in-process and cannot exercise the race (DEVELOPMENT.md §2); it
> verifies the SQL is _correct_, not that it is _race-safe_. Passes repeatedly (loop ≥ 20×
> in CI to catch flakes).

Test lives at `packages/store-postgres/test/no-oversell.pg.test.ts`, test name:
`"no oversell: N concurrent reserves at stock M (M<N) yield exactly M ok — Postgres"`.

---

## 2. Scope

### In scope

- Full workspace bootstrap: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`,
  oxlint + oxfmt configs, dependency-cruiser boundary rule wired into `pnpm lint`,
  changesets init, `.github/workflows/ci.yml` with a Postgres service container.
- `@otta-sh/domain`: branded money/id types (with the negative type-level test); the port
  interfaces (`InventoryStore`, `OrderStore`, `Clock`, `IdGen`) verbatim from
  adapter-architecture §2; inventory `reserve/commit/release` use-cases; an in-memory fake
  store; the reusable `inventoryStoreContract` suite.
- `@otta-sh/store-postgres`: one Kysely store, dialect-parameterized over `better-sqlite3`
  (local default) and `pg` (CI/prod); forward-only Phase-0 migration; the single-statement
  atomic reserve; idempotency via a `UNIQUE(idempotency_key)` constraint + replay semantics;
  the no-oversell concurrency test.
- `@otta-sh/service`: a thin Hono HTTP server mirroring the inventory port 1:1
  (`POST /inventory/reserve|commit|release`), Zod-validated bodies, `Idempotency-Key`
  header → domain `IdempotencyKey`, no status-code-as-logic; the live-test-server HTTP
  contract test.

### Explicitly out of scope (do NOT build)

- **`@otta-sh/store-emdash`** — write it only when EmDash ships CAS / unique constraints /
  plugin tables (adapter-architecture §6).
- **`InProcessCommerceClient`** and the **`CommerceClient` transport port** — Phase 1+, and
  the in-process client only when a second real transport exists (adapter-architecture §6).
- **`@otta-sh/plugin`** and any EmDash surface — Block Kit, sync hooks, storefront routes,
  `ctx.*` — all Phase 1+.
- **Any commerce subsystem beyond inventory**: catalog/`product_commerce`, cart, checkout,
  orders (beyond a placeholder `OrderStore` interface), customers, payments, tax, shipping,
  discounts, entitlements, webhooks. The component-map §5 Phase-0 row lists a fuller schema;
  we deliberately land **only `inventory` + `reservations`** in Phase 0 (see §6 Risks) and
  add the rest in their owning phases.
- `tsdown` production bundling correctness beyond "builds green" — no published release yet.

---

## 3. Dependencies

- **This phase depends on nothing.** It is the critical path and the root of the DAG.
- **What it provides downstream:**
  - Phase 1 (product model + sync) — the workspace, toolchain, CI, the `@otta-sh/service`
    REST shell to add read/upsert endpoints to, and the port/contract pattern the plugin's
    `CommerceClient` will mirror.
  - Phase 3 (cart + inventory) — the `InventoryStore` port, the atomic reserve, and the
    no-oversell guarantee it wraps end-to-end through a cart; the hold-expiry cron builds on
    `reservations.state` + `Clock`.
  - All phases — the branded money/id types, the domain-purity lint boundary, the
    `describeEachDialect`-style contract harness, and the `IdGen`/`Clock` ports.

---

## 4. Package & file layout

Target tree (only Phase-0 files; `packages/plugin`, `packages/store-emdash` are NOT created):

```
/                                             (standalone pnpm workspace)
├─ package.json                               root, private, scripts + packageManager pin
├─ pnpm-workspace.yaml                         packages/* + catalog: version pins
├─ pnpm-lock.yaml                              committed
├─ tsconfig.base.json                          strict compiler options, extended by each pkg
├─ tsconfig.json                               solution file: references all packages
├─ .oxlintrc.json                              oxlint, type-aware; domain import-restrictions
├─ .oxfmtrc.json                               oxfmt: tabs
├─ .dependency-cruiser.cjs                      domain-purity boundary rule (run in lint)
├─ vitest.workspace.ts                          projects: domain, store-postgres, service
├─ .changeset/
│  └─ config.json                              changesets init
├─ .github/workflows/ci.yml                     unit job + postgres-integration job
├─ .gitignore                                  (exists)
└─ packages/
   ├─ domain/                                  @otta-sh/domain — pure, NO io
   │  ├─ package.json                          name @otta-sh/domain, no pg/kysely/http deps
   │  ├─ tsconfig.json                         extends ../../tsconfig.base.json
   │  ├─ tsdown.config.ts                      ESM + DTS
   │  ├─ src/
   │  │  ├─ index.ts                           public barrel (ports + use-cases + types)
   │  │  ├─ money/
   │  │  │  ├─ cents.ts                        Cents, Currency, Money brand + constructors
   │  │  │  └─ ids.ts                          Sku, ProductId, IdempotencyKey, ReservationId
   │  │  ├─ ports/
   │  │  │  ├─ inventory-store.ts              InventoryStore, ReserveResult (verbatim §2)
   │  │  │  ├─ order-store.ts                  OrderStore (minimal, forward-looking)
   │  │  │  ├─ clock.ts                        Clock { now(): Date }
   │  │  │  └─ id-gen.ts                       IdGen { newId(): string }
   │  │  ├─ inventory/
   │  │  │  └─ use-cases.ts                    reserve/commit/release orchestration (IO-free)
   │  │  └─ testing/                           test-utils (IO-free), exported subpath
   │  │     ├─ in-memory-inventory-store.ts    the fake — first adapter
   │  │     └─ inventory-store-contract.ts     inventoryStoreContract(makeStore, {dialect})
   │  └─ test/
   │     ├─ money.type-test.ts                 negative type test (@ts-expect-error)
   │     ├─ money.test.ts                      runtime money constructor tests
   │     ├─ inventory-use-cases.test.ts        use-case behavior over the fake
   │     └─ inventory-store-contract.fake.test.ts   contract suite ⨯ fake
   ├─ store-postgres/                          @otta-sh/store-postgres — Kysely, both dialects
   │  ├─ package.json                          name @otta-sh/store-postgres; deps: kysely, pg, better-sqlite3
   │  ├─ tsconfig.json
   │  ├─ tsdown.config.ts
   │  ├─ src/
   │  │  ├─ index.ts                           barrel: KyselyInventoryStore + db factories
   │  │  ├─ schema.ts                          Kysely `Database` interface (typed tables)
   │  │  ├─ dialects.ts                        makePostgresDb(url) / makeSqliteDb(path)
   │  │  ├─ kysely-inventory-store.ts          KyselyInventoryStore implements InventoryStore
   │  │  └─ migrations/
   │  │     ├─ index.ts                        Kysely migration provider (ordered list)
   │  │     └─ 0001_phase0_inventory.ts        forward-only: inventory + reservations
   │  └─ test/
   │     ├─ describe-each-dialect.ts           harness: sqlite always; pg iff PG_CONNECTION_STRING
   │     ├─ inventory-store-contract.dialects.test.ts   contract ⨯ {sqlite, pg}
   │     └─ no-oversell.pg.test.ts             THE Phase-0 acceptance test (pg-required)
   └─ service/                                 @otta-sh/service — REST mirrors ports 1:1
      ├─ package.json                          name @otta-sh/service; deps: hono, zod, @hono/node-server
      ├─ tsconfig.json
      ├─ tsdown.config.ts
      ├─ src/
      │  ├─ index.ts                           bin entry: build deps, serve on PORT
      │  ├─ app.ts                             createApp(deps) → Hono instance (no listen)
      │  ├─ schemas.ts                         Zod request/response schemas
      │  └─ routes/
      │     └─ inventory.ts                    POST /inventory/reserve|commit|release
      └─ test/
         ├─ helpers/start-test-server.ts       boot createApp on ephemeral port, return baseUrl
         └─ http-inventory-contract.pg.test.ts contract cases over live HTTP (pg-backed)
```

### Config specifics (name them exactly)

- **`pnpm-workspace.yaml`** — `packages: ["packages/*"]`; a `catalog:` block pinning shared
  versions: `typescript`, `vitest`, `tsdown`, `oxlint`, `oxfmt`, `kysely`, `pg`,
  `@types/pg`, `better-sqlite3`, `@types/better-sqlite3`, `zod`, `hono`,
  `@hono/node-server`, `dependency-cruiser`, `@changesets/cli`. Each package references them
  as `"kysely": "catalog:"` etc.
- **Root `package.json`** — `"private": true`, `"packageManager": "pnpm@<pinned>"`, scripts:
  `lint` (`oxlint` + `dependency-cruiser --config .dependency-cruiser.cjs packages`),
  `typecheck` (`tsc -b`), `test` (`vitest run`), `test:pg` (`vitest run` with pg projects —
  env-gated), `format` (`oxfmt`), `build` (`pnpm -r build`), `changeset`
  (`changeset`). `pnpm test` runs the SQLite/unit subset; pg-required specs self-skip
  without `PG_CONNECTION_STRING`.
- **`tsconfig.base.json`** — `"strict": true`, `"noUncheckedIndexedAccess": true`,
  `"noImplicitOverride": true`, `"verbatimModuleSyntax": true`, `"module": "preserve"`,
  `"moduleResolution": "bundler"`, `"target": "ES2023"`, `"declaration": true`,
  `"composite": true`. Convention enforced by review + lint: **internal imports use `.js`
  extensions; type-only imports use `import type`.**
- **`.oxlintrc.json`** — type-aware; enable the import-restriction rule that forbids
  `@otta-sh/domain` sources from importing `pg`, `kysely`, `better-sqlite3`, `hono`,
  `node:http`, `node:https`, or `fetch`. (Belt-and-suspenders with dependency-cruiser.)
- **`.oxfmtrc.json`** — tabs (indent style = tab).
- **`.dependency-cruiser.cjs`** — **forbidden** rule `domain-is-io-free`: any module under
  `^packages/domain/src` that depends on `pg|kysely|better-sqlite3|hono|node:http|
  node:https|node-fetch` **or** on any `^packages/(store-.*|service|plugin)` is an error.
  Wired into `pnpm lint` so the boundary cannot rot silently (DEVELOPMENT.md §3).
- **`.changeset/config.json`** — default config; `@otta-sh/domain`, `@otta-sh/store-postgres`,
  `@otta-sh/service` are publishable; changeset required before a PR that changes a published
  package.
- **`vitest.workspace.ts`** — three projects so each package's tests run with its own
  config; pg-required files use `describe.skipIf(!process.env.PG_CONNECTION_STRING)`.
- **`.github/workflows/ci.yml`** — see §7.

---

## 5. Ordered red → green steps

Each step: **write the failing test first, then the minimum code to green.** A step is done
only when its named test passes (and `pnpm lint` + `pnpm typecheck` stay green). Steps map
to implementation-plan §0.1–0.6.

### Step 0.1 — Walking skeleton (repo + toolchain) · `[CI]`

No product code; prove the workspace builds and an empty suite runs green, and that the
boundary rule is _active_.

- **Red:** add one placeholder test per package
  (`packages/*/test/smoke.test.ts`, test name `"workspace smoke"`, `expect(true).toBe(true)`).
  Add a deliberately-violating fixture to confirm the boundary rule bites — a temporary
  `import pg from "pg"` in a scratch file under `packages/domain/src` must make `pnpm lint`
  fail; remove the fixture once confirmed.
- **Green (minimum):** author every config in §4; `pnpm install`; each package gets a
  minimal `package.json`, `tsconfig.json`, `tsdown.config.ts`, and `src/index.ts`.
- **✅ Green when:** `pnpm -r build && pnpm -r test` passes with the placeholder tests, and
  `pnpm lint` reports the `domain-is-io-free` rule active (fails on the fixture, passes
  after removal). (implementation-plan §0.1)

### Step 0.2a — Branded money + ids, with the negative type-level test · `[Domain]`

Money is defined now as foundation even though the inventory port itself takes no money —
it must exist and be proven float-proof before any priced subsystem (Phase 4).

- **Red (type-level):** `packages/domain/test/money.type-test.ts` — assertions that must
  _fail to compile if the brand is wrong_. Test name (via vitest `expectTypeOf`) and
  `@ts-expect-error` guards:
  - ``// @ts-expect-error — a plain number must not be assignable to Cents`` above
    `const c: Cents = 500;`
  - ``// @ts-expect-error — a float must not construct Cents`` above `cents(4.99);`
  - `expectTypeOf(cents(500)).toEqualTypeOf<Cents>()` (positive).
  This file is checked by `pnpm typecheck`: it "passes" iff each `@ts-expect-error` is
  actually triggered (a missing brand makes the suppressed error vanish → `tsc` reports the
  unused directive → typecheck fails). Runtime name in `money.test.ts`:
  `"cents() rejects non-integer input"` (throws at runtime too).
- **Green (minimum):** `src/money/cents.ts` — `type Cents = number & { readonly __brand: "Cents" }`,
  a `Currency` string-union/brand, a `Money = { amount: Cents; currency: Currency }`, and a
  smart constructor `cents(n: number): Cents` that throws on non-integer/negative and is the
  _only_ way to mint a `Cents`. `src/money/ids.ts` — the same branding pattern for `Sku`,
  `ProductId`, `IdempotencyKey`, `ReservationId` with `sku()`, `idempotencyKey()`, etc.
- **✅ Green when:** `money.test.ts` passes and the branded-money negative type-test compiles
  exactly as expected (fails to compile when the brand is removed). (implementation-plan §0.2)

### Step 0.2b — Port interfaces (verbatim from adapter-architecture §2) · `[Domain]`

- **Green (types only, no test yet — exercised by 0.2c/0.3):** `src/ports/inventory-store.ts`,
  reproduced verbatim from adapter-architecture §2:

  ```ts
  export interface InventoryStore {
  	// Atomic: decrement iff on_hand >= qty. Never oversell.
  	// `reserve` is a multi-statement choreography: an idempotency claim (single
  	// `INSERT … ON CONFLICT`), then a FINALIZE that couples the conditional inventory
  	// decrement with the `pending → held` flip so both commit all-or-nothing — see §0.5.
  	// The oversell-critical decrement is a single conditional statement; coupling it with the
  	// `held` flip is what guarantees the invariant `held ⟺ a durable decrement` (so `held` is
  	// never observable before stock was actually removed). On pg/sqlite the finalize is one
  	// short transaction on one connection; a future D1/`EmdashStore` must supply equivalent
  	// all-or-nothing semantics (CAS/batch) for that pair. A replay MUST resolve the
  	// reservation's *state* (held ⇒ ok, failed ⇒ OUT_OF_STOCK, pending ⇒ finalize-or-await),
  	// never assume the original call completed — see §0.5's replay choreography and the
  	// concurrent-same-key / crash-window contract cases it requires.
  	reserve(sku: string, qty: number, key: IdempotencyKey): Promise<ReserveResult>;
  	commit(reservationId: string): Promise<void>;
  	release(reservationId: string): Promise<void>;
  }
  export type ReserveResult =
  	| { ok: true; reservationId: string }
  	| { ok: false; reason: "OUT_OF_STOCK" };
  ```

  Plus `src/ports/order-store.ts` (`OrderStore` — minimal placeholder interface, defined for
  completeness per §0.2, exercised in Phase 4), `src/ports/clock.ts`
  (`Clock { now(): Date }`), `src/ports/id-gen.ts` (`IdGen { newId(): string }`).
  > **Note on `sku: string` vs branded `Sku`:** the §2 signature is kept verbatim (`sku:
  > string`, `qty: number`) so the port stays maximally portable to a future `EmdashStore`;
  > branding is applied at the use-case boundary. See §8 Risk R1 for the recommended
  > resolution.

### Step 0.2c — Inventory use-cases + in-memory fake · `[Domain]`

- **Red:** `packages/domain/test/inventory-use-cases.test.ts`, running against the fake:
  1. `"reserve within stock decrements and returns ok"` — `qty <= on_hand` → `{ ok: true }`,
     `on_hand` decremented by `qty`.
  2. `"reserve beyond stock returns OUT_OF_STOCK and does not decrement"` — `qty > on_hand`
     → `{ ok: false, reason: "OUT_OF_STOCK" }`, `on_hand` unchanged.
  3. `"reserve replayed with same IdempotencyKey returns same reservationId and decrements once"`.
  4. `"commit finalizes; release returns stock; double-commit and double-release are no-ops"`.
- **Green (minimum):** `src/inventory/use-cases.ts` — thin IO-free orchestration
  `reserve(store, sku, qty, key)`, `commit(store, reservationId)`, `release(...)` delegating
  to the port (brand `sku` here). `src/testing/in-memory-inventory-store.ts` — an IO-free
  `InventoryStore` fake constructed with `{ idGen, clock, seed }`; a `Map<Sku, number>` for
  `on_hand`, a `Map<idempotencyKey, ReservationId>` for replay, and a `Map<reservationId,
  {sku, qty, state}>`. `newId()` from the injected `IdGen` (deterministic in tests).
- **✅ Green when:** all four pass against the fake. (implementation-plan §0.2)

### Step 0.3 — The reusable contract suite · `[Domain]`

Lift 0.2c's expectations into one parameterized suite so every adapter runs the _same_ tests
(mirrors EmDash `describeEachDialect`).

- **Red:** `src/testing/inventory-store-contract.ts` exporting
  `inventoryStoreContract(makeStore: () => Promise<{ store: InventoryStore; seed(sku, qty):
  Promise<void>; onHand(sku): Promise<number> }>, opts: { dialect: string })`. It re-expresses
  the four behavioral cases (plus an idempotency-replay case). Consumed by
  `packages/domain/test/inventory-store-contract.fake.test.ts` (test group name
  `"inventoryStoreContract [fake]"`).
- **Green (minimum):** the fake is the **first adapter** to pass it — proving the suite is
  real and the port shape is right before any DB.
- **✅ Green when:** `inventoryStoreContract` passes against the fake. (implementation-plan §0.3)

### Step 0.4 — Kysely store on both dialects, forward-only migration · `[Adapters]`

One Kysely-backed store, dialect-parameterized so the same code runs on `better-sqlite3`
(fast/local) and `pg` (CI/prod). Package name reflects the prod target; the code is
dialect-agnostic (EmDash pattern).

- **Red:** `packages/store-postgres/test/inventory-store-contract.dialects.test.ts` runs
  `inventoryStoreContract` via `describe-each-dialect.ts` — **SQLite always**, **Postgres
  when `PG_CONNECTION_STRING` is set** (`describe.skipIf`). Per-test isolation: each run
  creates a fresh schema (Postgres: `CREATE SCHEMA test_<rand>; SET search_path`) or a fresh
  in-memory/temp DB (SQLite), runs migrations, tears down after.
- **Green (minimum):**
  - `src/migrations/0001_phase0_inventory.ts` (forward-only; §6 schema) — creates `inventory`
    and `reservations` with `UNIQUE(idempotency_key)`.
  - `src/schema.ts` — Kysely `Database` interface typing both tables.
  - `src/dialects.ts` — `makeSqliteDb(path)` (`better-sqlite3` dialect) and
    `makePostgresDb(url)` (`pg` `Pool` dialect).
  - `src/kysely-inventory-store.ts` — `KyselyInventoryStore` implementing `InventoryStore`.
    The **atomic reserve** is the single conditional statement (see 0.5 for the exact SQL
    and idempotency choreography); `commit`/`release` flip `reservations.state` idempotently.
- **✅ Green when:** the contract suite is green on SQLite and (in CI / with
  `PG_CONNECTION_STRING`) on Postgres. (implementation-plan §0.4)

### Step 0.5 — No-oversell under concurrency (THE Phase-0 gate) · `[Adapters]`

- **Red:** `packages/store-postgres/test/no-oversell.pg.test.ts`, `describe.skipIf(!PG)`,
  test name `"no oversell: N concurrent reserves at stock M (M<N) yield exactly M ok —
  Postgres"`. Seed `on_hand = M`; build a `pg.Pool` (max ≥ N) so each concurrent `reserve`
  acquires an **independent connection**; fire `N` reserves (distinct idempotency keys) via
  `Promise.all`; assert exactly `M` `ok`, `N − M` `OUT_OF_STOCK`, final `on_hand == 0`. Loop
  the scenario ≥ 20× to catch flakes.
- **Green (minimum) — the reserve implementation that makes it pass:** the decrement is the
  single conditional `UPDATE … RETURNING` (no `FOR UPDATE`, no interactive transaction, so a
  future D1/`EmdashStore` satisfies the same contract):

  ```sql
  UPDATE inventory SET on_hand = on_hand - :q
   WHERE sku = :s AND on_hand >= :q
  RETURNING on_hand;   -- 0 rows returned = OUT_OF_STOCK
  ```

  **Idempotency + replay choreography.** The idempotency claim is a single
  `INSERT … ON CONFLICT`; the oversell-critical decrement is the single conditional `UPDATE`
  above; and the decrement is coupled with the `pending → held` flip so that **`held` is never
  observable until the decrement is durably committed** — the invariant (`held ⟺ durable
  decrement`) that makes replay-by-state safe. On Postgres/SQLite that coupling is a short
  finalize **transaction** on one connection (scoped to exactly those two writes, not an
  interactive session over the whole request); a future D1/`EmdashStore` must supply
  equivalent all-or-nothing semantics for the same pair (CAS/batch) — see §8 R6.
  1. `INSERT INTO reservations (id, sku, qty, state, idempotency_key) VALUES (…, 'pending', :key)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id;` — single statement, autocommit.
     - **Row returned:** the key is freshly claimed by this caller; proceed to the finalize
       transaction (2) as the claimant.
     - **No row (key already claimed):** `SELECT id, state FROM reservations WHERE
       idempotency_key = :key` and resolve from the stored **state** — never a blind `ok`:
       - `state = 'held'` → return `{ ok: true, reservationId: id }`. Because `held` is only
         ever committed *together with* the inventory decrement (2), a `held` row is proof the
         stock was durably removed.
       - `state = 'failed'` → return `{ ok: false, reason: "OUT_OF_STOCK" }` (§8 R2).
       - `state = 'pending'` → the reservation was claimed but never reached a terminal
         state. This covers (a) the original call still genuinely in flight (a concurrent
         same-key double-click), and (b) the original process crashed after the `INSERT` but
         before/inside the finalize transaction (which then rolled back atomically, leaving
         `pending`). Critically, **a `pending` row is proof that no decrement has committed**
         (a decrement only commits in lock-step with the `pending → held` flip), so it is safe
         for the replaying caller to run the finalize transaction (2) itself, racing whoever
         else observes `pending`. On losing the guarded flip it **re-reads `state`** (a bounded
         short retry/backoff) until it observes the now-terminal `held`/`failed`, then returns
         that. This closes both the crash window (an abandoned `pending` is resolved, never
         assumed complete) and the concurrent-in-flight race (no caller returns `ok` before the
         row is terminal).
  2. **Finalize — atomic (one transaction on Postgres/SQLite; equivalent CAS/batch on a future
     D1 store).** Whichever caller is finalizing (the step-1 claimant, or a replay caller
     resolving an observed `pending` row) runs, inside the transaction:
     - `UPDATE reservations SET state = 'held' WHERE id = :id AND state = 'pending'
       RETURNING id;` — the **claim guard**. **0 rows** ⇒ another caller already finalized (or
       is finalizing) this reservation → ROLLBACK and fall to the re-read loop above. **1 row**
       ⇒ this caller owns the finalize; proceed.
     - The atomic conditional `UPDATE inventory … RETURNING` (above).
       - **1 row (stock available):** COMMIT. The `held` flip and the decrement commit
         **together**; return `{ ok: true, reservationId: id }`.
       - **0 rows (OUT_OF_STOCK):** `UPDATE reservations SET state = 'failed' WHERE id = :id`,
         then COMMIT (the transient `held` set by the claim flip is overwritten within the
         same transaction and never becomes externally visible; the key stays consumed so a
         replay of the _same_ key is stable); return `{ ok: false, reason: "OUT_OF_STOCK" }`.

  **Why `held` is set with — never before — the decrement.** An earlier draft flipped
  `pending → held` and *then* decremented as two separate autocommit statements. A crash — or a
  concurrent same-key replay — in that gap left a **visible `held` row whose stock was never
  removed**; replays treat `held` as terminal-ok, so a later `commit`/`release`/expiry would
  add or double-count stock that was never decremented → oversell, the one non-negotiable this
  repo exists to prevent. Committing the flip and the decrement in one transaction erases the
  gap: the only non-terminal outcome any crash can leave is `pending` **with no decrement**,
  which is inert (holds no stock, invisible to Phase-3's `held`-scoped sweep) and is healed by
  the next same-key replay via (1)'s `pending` branch — or left as a harmless orphan if none
  ever comes (optionally reaped by a `pending`-TTL janitor; not oversell-relevant, since it
  holds nothing).

  The unique `idempotency_key` constraint is the race guard between concurrent identical keys;
  the `state`-guarded flip (`WHERE state = 'pending'`) makes exactly one caller finalize a
  given reservation; the conditional inventory `UPDATE` is the race guard against oversell; and
  the finalize transaction guarantees `held ⟺ durable decrement`. The oversell-critical
  decrement is still a single conditional statement — no `FOR UPDATE`, no interactive
  read-modify-write — so the *decrement* ports unchanged; only its all-or-nothing coupling with
  the `held` flip is a store-provided atomicity property (§8 R6, mirroring Phase 5's
  service-only outbox transaction). (See §8 R2 for the failed-key replay policy.)

  **Required contract cases (each crash window named):**
  - `"concurrent reserve calls sharing the same idempotency key never return ok before the
    reservation reaches a terminal state"` — race two (or more) concurrent `reserve` calls
    with the identical key against a seeded low-stock SKU (e.g. an injected delay on one
    call's finalize forces the other to observe `pending`); assert every caller's result
    matches the *same* terminal outcome (`ok` or `OUT_OF_STOCK`) and the inventory is
    decremented **exactly once**. Runs against the fake first (deterministic ordering) and is
    folded into the Postgres no-oversell suite (0.5) as a same-key variant of the concurrency
    loop, alongside the existing distinct-key cases.
  - `"reserve heals a reservation abandoned in 'pending' before finalize (crash window W1) on
    same-key replay"` — leave a `pending` reservation with the finalize never run (simulating a
    crash after step 1's `INSERT` committed); replay the same key and assert it completes to
    the correct terminal (`held` with stock decremented **exactly once** when stock is
    available; `failed`, no decrement, when not), never double-decrementing. Fake + Postgres.
  - `"reserve finalize is all-or-nothing: a fault between the held flip and the decrement leaves
    'pending' with on_hand unchanged (crash window W2)"` — inject a fault inside the finalize
    transaction after the claim flip and before commit; assert the transaction rolls back to
    `state = 'pending'` with `on_hand` unchanged (no externally-visible `held`, no partial
    decrement), and that a subsequent same-key replay heals it per W1. Postgres (the finalize
    transaction is the mechanism under test; `better-sqlite3` verifies the SQL, not the crash
    timing).
- **✅ Green when:** it passes repeatedly on Postgres. **This is the gate for the whole
  two-part architecture.** (implementation-plan §0.5)

### Step 0.6 — REST service that mirrors the ports 1:1 · `[Service]`

- **Red:** `packages/service/test/http-inventory-contract.pg.test.ts`, `describe.skipIf(!PG)`,
  test group `"HTTP inventory contract [live server, Postgres]"`. It reuses the _same
  behavioral cases_ as the store contract but drives them over **real HTTP** against a live
  test server (`helpers/start-test-server.ts` boots `createApp(deps)` on an ephemeral port
  with a Postgres-backed `KyselyInventoryStore`, returns `baseUrl`; torn down after). Asserts
  wire ⇄ port fidelity: `reserve` success/`OUT_OF_STOCK`, and replay via a repeated
  `Idempotency-Key` header returning the same `reservationId`.
- **Green (minimum):** thin Hono server. `src/schemas.ts` — Zod bodies for reserve
  (`{ sku, qty }`), commit/release (`{ reservationId }`); `Idempotency-Key` **header** →
  domain `IdempotencyKey`. `src/routes/inventory.ts` — `POST /inventory/reserve`,
  `/inventory/commit`, `/inventory/release`, each a straight serialization of the port
  method: parse+validate → call domain use-case → serialize `ReserveResult` to JSON. **No
  status-code-as-logic** — `OUT_OF_STOCK` is a `200` body `{ ok: false, reason:
  "OUT_OF_STOCK" }`, not a `409` (the port has no exception for it); `400` only for schema
  validation failure. `src/app.ts` — `createApp(deps)` returns the Hono app without
  listening (so tests mount it); `src/index.ts` — bin entry that wires
  `makePostgresDb` + `KyselyInventoryStore` and serves on `PORT`.
- **✅ Green when:** the HTTP contract test passes against a live server backed by Postgres.
  (implementation-plan §0.6)

**Suggested PR slicing** (one PR = one thing, per CLAUDE.md scope discipline): PR-1 = 0.1
`[CI]`; PR-2 = 0.2a–0.3 `[Domain]`; PR-3 = 0.4–0.5 `[Adapters]`; PR-4 = 0.6 `[Service]`.
Each PR records its passing suite; PR-3 and PR-4 attach the Postgres run.

---

## 6. Schema (Phase 0 only)

Two tables, created by the single forward-only migration
`packages/store-postgres/src/migrations/0001_phase0_inventory.ts`. Written with Kysely's
schema builder so identical DDL emits for both dialects; types kept portable
(`integer`/`text`, no Postgres-only features), so the same migration serves SQLite and — in
principle — a future D1 store.

**`inventory`**

| column     | type              | constraints                          |
|------------|-------------------|--------------------------------------|
| `sku`      | text              | **PRIMARY KEY**                      |
| `on_hand`  | integer           | NOT NULL, **CHECK (`on_hand >= 0`)** |

The CHECK is defense-in-depth; the conditional `WHERE on_hand >= :q` is the real guard.

**`reservations`**

| column            | type    | constraints                                             |
|-------------------|---------|---------------------------------------------------------|
| `id`              | text    | **PRIMARY KEY** (from `IdGen`, e.g. UUID/ULID string)   |
| `sku`             | text    | NOT NULL (FK → `inventory.sku`; unenforced on D1 later) |
| `qty`             | integer | NOT NULL, CHECK (`qty > 0`)                             |
| `state`           | text    | NOT NULL, one of `pending` \| `held` \| `committed` \| `released` \| `failed` |
| `idempotency_key` | text    | NOT NULL, **UNIQUE** ← idempotency guard                |
| `created_at`      | text    | NOT NULL (ISO-8601 from `Clock.now()`)                  |

**Migration approach:** forward-only, numbered, append-only (`0001_…`, `0002_…`). A Kysely
migration provider lists them in order; a tiny migrate step runs in test setup (fresh
schema/db per run) and will run at service boot later. Never edit a shipped migration —
correct forward with a new one (DEVELOPMENT.md §6, CLAUDE.md). Money columns are deliberately
absent in Phase 0 — priced tables (`product_commerce`, order line items) arrive in their
owning phases as `integer` minor-unit columns.

**Money-column naming convention (set here, binding on all downstream phases):** every money
column introduced later uses the **`_cents`** suffix (matching the branded `Cents` type),
e.g. `price_cents`, `subtotal_cents`, `total_cents` — never `_amount` or `_minor`. Phase 0
itself has no money columns to rename; this is a preventive rule so Phases 1+ don't each
invent their own suffix (see Phase 1's revision log for the first application of this rule).

---

## 7. CI design (`.github/workflows/ci.yml`)

Two jobs; the second depends on the first passing.

1. **`unit`** (ubuntu-latest, no database):
   - `pnpm/action-setup` + `actions/setup-node` (node 22) with pnpm cache.
   - `pnpm install --frozen-lockfile`.
   - Steps in order: `pnpm lint` (oxlint + dependency-cruiser boundary — **domain purity is
     a CI gate**) → `pnpm typecheck` (`tsc -b`; this is where the money negative type-test is
     enforced) → `pnpm -r build` → `pnpm test` (SQLite + fake contract suite; pg-required
     specs self-skip because `PG_CONNECTION_STRING` is unset).
2. **`integration`** (`needs: unit`, Postgres service container):
   - `services.postgres`: `postgres:16`, `POSTGRES_PASSWORD`, `POSTGRES_DB=otta_test`, a host
     port mapped onto the container's Postgres port, health-check (`pg_isready`) so the job
     waits until ready.
   - `env.PG_CONNECTION_STRING`: the workflow's own service-container URL, set in
     `.github/workflows/ci.yml` beside the service that backs it. It is scoped to the CI
     runner and **must not be copied into a local shell** — see the note below.
   - `pnpm install --frozen-lockfile` → `pnpm test:pg` — runs the **Postgres** contract
     dialect, the **no-oversell** acceptance test (0.5), and the **live-server HTTP contract**
     test (0.6). Because `PG_CONNECTION_STRING` is set, the `skipIf` guards flip on and these
     run for real.

**How the env gates tests:** every Postgres-touching spec is `describe.skipIf(!process.env.
PG_CONNECTION_STRING)`. Locally with no Postgres, `pnpm test` is fast and green (SQLite +
fake) and prints skips; the pg suites only execute where the connection string exists (the
`integration` job, or a dev who exports it). This is exactly DEVELOPMENT.md §2: SQLite verifies
the SQL, Postgres verifies the race. **Merge gate:** both jobs green + changeset present when
a published package changed. Migrations forward-only (a lint/check can assert no shipped
migration file changed).

**Running the pg suites locally — use the throwaway test container, on port 55432.** The repo
documents one shape for this and it is the only one to copy
([`README.md`](../README.md), [`sites/staging/README.md`](../sites/staging/README.md)):

```bash
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta_test pnpm test:pg
```

The port is prefixed deliberately, so a throwaway test container cannot collide with — or be
mistaken for — whatever is already listening on the machine's default Postgres port. **Never point
this project's tooling at that default port:** these suites create and drop schemas, nothing in
this repo needs a database that is not the disposable one, and "it happened to be running" is not
a reason to write to it. The CI job's connection string above lives in the workflow file, next to
the ephemeral container it addresses, and is not a value to reuse anywhere else.

---

## 8. Risks & open questions

- **R1 — `sku: string` (verbatim §2 port) vs branded `Sku` (CLAUDE.md / §0.2).** The §2
  signature uses `sku: string`; CLAUDE.md wants branded ids. **Recommendation:** keep the
  **port** signature verbatim `string` (maximizes portability to a future `EmdashStore` and
  matches the doc), and brand at the **use-case boundary** (`inventory/use-cases.ts` takes
  `Sku`, passes the unwrapped string to the port). Money branding (`Cents`) is unaffected —
  inventory carries no money in Phase 0. Revisit only if a later phase wants the brand to
  reach the port.
- **R2 — Replay semantics for a _failed_ (OUT_OF_STOCK) idempotency key.** If the same key is
  replayed after an original `OUT_OF_STOCK`, should it re-attempt the decrement or return the
  stored `OUT_OF_STOCK`? **Recommendation:** the key stays consumed (`state = 'failed'`);
  replaying it returns `OUT_OF_STOCK` deterministically — once-only, stable. A genuine retry
  after restock uses a **new** key. Add a contract case pinning this so no adapter drifts.
- **R3 — `qty` and `reservationId` types across the port.** `qty: number` and
  `reservationId: string` are verbatim `number`/`string` (a count, not money — no float
  hazard). No change recommended; noted so no one "helpfully" brands them and breaks the
  verbatim port.
- **R4 — Schema breadth mismatch.** component-map §5 lists a large Phase-0 schema
  (`product_commerce`, `carts`, `orders`, …); implementation-plan §0 lands only
  `inventory` + `reservations`. **Recommendation:** follow implementation-plan (TDD, one
  thing at a time, no speculative tables); the other tables arrive with the use-cases that
  test them. This plan builds only the two inventory tables.
- **R5 — `IdGen` implementation.** `newId()` needs a collision-free id (UUIDv7/ULID for sort
  or `crypto.randomUUID()`). **Recommendation:** the domain defines the `IdGen` _port_ only;
  each adapter injects a concrete generator (`crypto.randomUUID()` is fine, zero-dep), tests
  inject a deterministic counter. Keeps the domain IO-free.
- **R6 — Reserve is a multi-statement sequence, not literally one statement.** DEVELOPMENT.md
  §2 stresses "single-statement atomic write"; the reserve here is `INSERT … ON CONFLICT` +
  a guarded `held` flip + the conditional inventory `UPDATE` (+ a `failed` flip on OOS).
  **Resolution:** the _oversell-critical_ operation is the single conditional
  `UPDATE inventory … WHERE on_hand >= :q` (that is what §2 means), and the idempotency claim
  is a separate single-statement `INSERT … ON CONFLICT` — both port unchanged, no `FOR UPDATE`,
  no interactive read-modify-write. The **one** place correctness genuinely requires atomicity
  is the **finalize pair** (`pending → held` flip + the decrement): they must commit
  all-or-nothing so that `held` is never observable without a durable decrement (§0.5). On
  Postgres/SQLite that is a short transaction on one connection — scoped to exactly those two
  writes, not a session spanning the whole request — **mirroring the precedent Phase 5 sets for
  its service-only outbox** (transition + outbox insert in one transaction). A future
  D1/`EmdashStore` must supply equivalent all-or-nothing semantics for the pair (CAS or a batch
  write) and satisfy §0.5's crash-window contract cases; this is stated as a doc-comment on
  `InventoryStore.reserve` itself (§0.2b, done) so a port-only reader sees the
  finalize-atomicity + replay-by-state contract in the code, not just in this plan. This is a
  design constraint to hold, not a blocker. (Per the governing rule: single-statement guarded
  writes are the default; a real transaction is acceptable where a multi-row invariant — here,
  `held ⟺ durable decrement` — demands it, exactly as Phase 5 established.)
- **R7 — Postgres per-test isolation strategy.** Per-schema (`CREATE SCHEMA` +
  `search_path`) vs per-database. **Recommendation:** per-schema — cheaper, and one container
  serves the whole suite; the no-oversell test still races real connections within its schema.

---

## 9. Definition of done (restated from implementation-plan §0 as a checklist)

- [ ] **Contract suite green on both dialects** — `inventoryStoreContract` passes against the
  in-memory fake, SQLite (`better-sqlite3`), and Postgres (`pg`).
- [ ] **No-oversell green on Postgres** — `no-oversell.pg.test.ts` passes repeatedly:
  N concurrent reserves at stock M (M < N) on independent connections yield exactly M `ok`,
  N − M `OUT_OF_STOCK`, final `on_hand == 0`.
- [ ] **Service endpoints pass the live-server contract test** — the same behavioral cases
  run over real HTTP against a live, Postgres-backed `@otta-sh/service`; wire mirrors the port
  1:1 (no status-code-as-logic; `Idempotency-Key` header → domain key).
- [ ] **`@otta-sh/domain` imports nothing with IO** — `pnpm lint` (dependency-cruiser
  `domain-is-io-free` + oxlint import-restriction) is green; no `pg`/`kysely`/`ctx`/`fetch`
  in the domain.
- [ ] **Branded money proven** — the negative type-level test fails to compile without the
  brand and passes with it (enforced by `pnpm typecheck`).
- [ ] **Idempotency tested** — replayed `reserve` with the same key decrements once and
  returns the same `reservationId`, on every adapter.
- [ ] **Concurrent same-key replay tested** — the required contract case (§0.5) proving two
  concurrent `reserve` calls sharing an idempotency key never return `ok` before the
  reservation reaches a terminal state, and decrement inventory exactly once; green against
  the fake and folded into the Postgres no-oversell suite.
- [ ] **Crash-window healing tested** — the finalize is all-or-nothing (`held ⟺ durable
  decrement`): a reservation abandoned in `pending` before finalize (window W1) heals to the
  correct terminal on same-key replay with exactly-one decrement, and a fault inside the
  finalize transaction (window W2) rolls back to `pending` with `on_hand` unchanged (no visible
  `held`, no partial decrement). Green on Postgres (§0.5).
- [ ] **Toolchain gates green** — `pnpm lint`, `pnpm typecheck`, `pnpm -r build`,
  `pnpm format` (tabs) all clean.
- [ ] **Changeset added** for the published packages changed; migrations forward-only.
- [ ] **CI green** — both `unit` and `integration` jobs pass; the Postgres run is recorded in
  the PR (DEVELOPMENT.md §1 / CLAUDE.md verification policy).
- [ ] **No out-of-scope surface** — no `@otta-sh/plugin`, `@otta-sh/store-emdash`,
  `InProcessCommerceClient`, or EmDash `ctx.*` introduced.

---

## 10. Revision log (post-approval review fold-in)

- **Round 2 — replay choreography flipped `pending → held` BEFORE the decrement, reintroducing
  a crash-window oversell (Reviewer A NEW-1, blocker; Reviewer B New-2, should-fix; same window
  flagged by both).** A crash — or a concurrent same-key replay — between the `held` flip and
  the decrement left a *visible* `held` reservation whose stock was never removed; replays treat
  `held` as terminal-ok, so a later `commit`/`release`/expiry would corrupt `on_hand` →
  oversell. Resolution: redesigned §0.5 so `held` is only ever committed **together with** the
  decrement in a short finalize **transaction** on one connection (the Phase-5 precedent for a
  multi-row invariant), establishing the invariant `held ⟺ durable decrement`. The only
  non-terminal state a crash can now leave is `pending` with **no decrement** (inert, invisible
  to Phase-3's `held`-scoped sweep), healed by same-key replay via (1)'s `pending` branch. R6
  and the `InventoryStore.reserve` doc-comment (§0.2b) were amended to scope single-statement
  portability to the oversell-critical decrement alone and require a future D1 store to supply
  equivalent finalize atomicity + pass the crash-window contract cases. Added two named crash-
  window contract cases (W1 abandoned-`pending` heal, W2 finalize rollback) to §0.5 and a
  crash-window-healing item to the DoD.
- **Round 1 — concurrent same-key replay could return a premature `ok` / crash-window
  oversell-on-replay (Reviewer A should-fix, Reviewer B should-fix).** Resolution: rewrote the
  §0.5 replay choreography so the "no row" branch resolves from the reservation's stored `state`
  (`held`/`failed`) instead of assuming the original call finished; a `pending` row (in-flight
  *or* crashed original call) is resolved by a `state`-guarded flip
  (`WHERE id=:id AND state='pending'`) so exactly one caller ever decrements inventory for
  that reservation, with losers re-reading `state` until terminal. Added a required contract
  case ("concurrent reserve calls sharing the same idempotency key never return ok before the
  reservation reaches a terminal state") to §0.5 and the DoD checklist. _(The Round-1 fix left
  the `held`-before-decrement ordering that Round 2 above corrects.)_
- **"No interactive transaction" claim vs. multi-statement reserve self-contradiction
  (Reviewer B should-fix; Reviewer A nit 2).** Resolution: added a doc-comment directly on
  `InventoryStore.reserve` (§0.2b) stating the multi-statement/replay-by-state contract, and
  cross-referenced it from R6, so a future `EmdashStore` author reads the constraint from the
  port itself, not only from this plan.
- **Money-column naming convention not fixed at the point it could prevent drift (Reviewer B
  nit).** Resolution: added a one-line binding convention to §6 (`_cents` suffix, matching the
  branded `Cents` type) for all money columns introduced in later phases; applied first in
  Phase 1 (see that plan's revision log).
- **R1–R5, R7 (sku/qty typing, failed-key replay policy, schema breadth, `IdGen`, per-schema
  isolation) — no change.** Reviewed against both reports; no should-fix or nit raised against
  them. Kept as-is.
