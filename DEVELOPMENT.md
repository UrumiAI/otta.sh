# Otta — Development Practices

_How we build Otta. Read this before writing code._

Otta is a standalone repo (its own git history, its own pnpm workspace) that
**mirrors [EmDash]'s conventions** without inheriting its config. Where EmDash has a
practice that fits a commerce plugin, we copy it. Where commerce needs more (money,
concurrency, idempotency), we add rules EmDash doesn't have.

[EmDash]: https://github.com/emdash-cms/emdash

---

## 1. TDD is contract-first

The order is always: **failing test → code → green → refactor.** A behavior without a
reproducing test is not done, and a bug without a reproducing test is not fixed.

Otta's stronger rule: **the contract test suite is the spec.** For anything in
`@otta-sh/domain`, write the behavioral test against the **port interface** before writing
any adapter. The adapter is "done" the day it turns that suite green — nothing else counts
as done.

- **Headline contract:** _no oversell under concurrency._ Fire N concurrent `reserve`s at
  stock M (M < N); assert **exactly M** succeed and the rest get `OUT_OF_STOCK`. Written
  once, run against every `InventoryStore` adapter.
- One behavioral suite lives in the domain (or a shared test package) and runs against
  **every** dialect beneath the one store adapter, `@otta-sh/store-emdash` — SQLite and
  Postgres via `packages/store-emdash/test/describe-each-dialect.ts`, and real D1 in its own
  tier (below). This mirrors EmDash's `describeEachDialect`.

## 2. Real databases, never mocks

No DB mocks, ever — same as EmDash. A mocked store can't catch the races and constraint
violations that are the entire point of the commerce layer.

- **SQLite (better-sqlite3) is the fast default.** Every contract test runs on it locally;
  no setup, sub-second.
- **Postgres runs in CI** and is opt-in locally via env (per-test schema isolation, real
  `pg` connection).
- **The concurrency test is Postgres-required.** `better-sqlite3` serializes writes in one
  process, so it cannot exercise a real race — it verifies the _SQL is correct_, not that
  it's _race-safe_. Mark the no-oversell test to run only against Postgres (and D1, its own
  tier below), and say so in the test name.
- **Real D1 is its own tier, and it is the release gate.** `pnpm test:d1` runs the contract
  suites and the races against a real D1 inside `workerd`, under the Cloudflare workers
  pool — the dialect the storefront actually ships on, and the only tier that exercises the
  host's own Kysely wiring. It lives in a **separate vitest project**
  (`packages/store-emdash/vitest.d1.config.ts`), deliberately not aggregated into the root
  config: the root config turns file parallelism off whenever `PG_CONNECTION_STRING` is set,
  and that guard belongs to the Postgres tier alone. Everything is local (miniflare's D1
  simulator — no Cloudflare account, token or remote database), but it boots workerd and
  re-migrates per file, so it runs as CI's `d1` job — on demand, and gating the
  merge into `main` — rather than on every PR.

Every dialect runs the same write model, recorded in
[ADR-0019](./adr/0019-commerce-aggregates-are-one-document-each.md): **one storage document per
aggregate, written by compare-and-set against its revision** and retried on conflict
(`packages/store-emdash/src/cas-retry.ts`). The host's per-plugin store's only atomicity
primitives are the conditional writes (`updateIf`, `getVersioned`, `compareAndSet`, `compareAndDelete`) —
no transaction, no multi-row batch, no raw SQL — so an invariant that spans two facts lives in
one document (the inventory document records the holds applied to it, which is what makes a
reserve replayable), and a coupling that spans two aggregates is made idempotently completable
and swept. No `SELECT … FOR UPDATE`, no interactive transactions. The single-statement
conditional `UPDATE` this section once prescribed can decrement but cannot record the hold that
makes the decrement replayable; ADR-0019 is where that was reversed.

## 3. Ports-and-adapters purity is enforced, not trusted

`@otta-sh/domain` depends on **nothing with IO**. A `pg`, `ctx`, or `fetch` import in the
domain is a build-breaking bug, not a code-review nit.

- The boundary is enforced by dependency-cruiser (`.dependency-cruiser.cjs`), run as part of
  `pnpm lint`, so the layering can't rot silently.
- **There is no wire to keep in step.** Commerce runs in-process: the plugin builds
  `InProcessCommerceClient` through its single composition root, `makeCommerceClient`, which
  binds the `@otta-sh/domain` use-cases to the `@otta-sh/store-emdash` stores over
  `ctx.storage` (ADR-0018). No REST API, no `@otta-sh/service`, no serialization layer that
  could drift from the port. The behavioral contract suite that used to run twice — once
  over HTTP against a live test server, once in-process — still runs every one of those
  cases, now against that single tier, over a real document store, with `ctx.http` bound to
  a rejecting stub so an accidental egress fails the suite.
- **Add an adapter only when a second real implementation exists.** No speculative adapter
  ahead of the host primitive it needs — the EmDash stores waited for the conditional-write
  primitives (ADR-0018).

## 4. Commerce invariants (rules EmDash doesn't need)

- **Money is integer minor units. Never floats.** Amounts are branded integer types (e.g.
  `Cents`) carrying an explicit currency; a `number` that reaches a money field is a type
  error. No float ever touches a price, tax, or total.
- **A minor unit is the currency's own.** The exponent comes from ONE table,
  `packages/domain/src/money/currencies.ts` (ISO 4217: USD 2, JPY 0, KWD 3; mirrored, and
  pinned identical by a test, in `packages/admin-presentation/src/currencies.ts`). Money
  inputs, display, refund flags and the Stripe amount mapping all read it, so `1500` typed
  for JPY is stored as 1500 and shown as ¥1,500. To support another currency, add a row there
  (its header says how). Merchant-typed currencies must be in the table; stored data in any
  shape-valid code still loads, and a code outside the table is typed in hundredths, as
  before the table existed.
- **Only the final total is ever rounded.** A currency whose row has a `paymentIncrement`
  (KWD, BHD, OMR, JOD: 10) has its order total rounded half-up to it after tax; the signed
  difference is `roundingCents` (`SignedCents` — `Cents` is never negative). Every part stays
  exact, and a currency without an increment never gains the field (ADR-0035 amendment).
- **Idempotency lives in the domain.** Every command carries an `idempotencyKey`; the store
  enforces once-only. Dedupe in the domain/store, never only in the HTTP client — and test
  the replay case.
- **Orders snapshot price and title at purchase time.** A test asserts that editing a
  product after an order never rewrites that order's line items.

## 5. The plugin is sandbox-clean, and we prove it

The plugin ships to other merchants' sites, so it must run under the sandbox with no
in-process leniency.

- **Dev and test against the workerd-on-Node sandbox**, not trusted in-process mode. If it
  only works trusted, it's broken.
- **Block Kit on the plugin's descriptor; React only on a second, native one.** The
  discriminator is the declared `format`, not placement: `format: "native"` may declare
  `adminEntry` (a React admin surface); a `format: "standard"` descriptor that declares
  `adminEntry` (or `componentsEntry`) throws at build time (EmDash's Astro integration).
  `@otta-sh/plugin` registers `format: "standard"` (ADR-0006), and its admin pages — Reports,
  Settings, Coupons, Tax, Shipping — are Block Kit `elements`. Orders and Themes are React
  pages, and pricing and stock React cards in the product editor and list columns inside the products collection,
  all in `@otta-sh/admin-react` on the separate `otta-console` native descriptor (ADR-0014),
  which replaced the duplicated Block Kit screens (ADR-0015);
  `@otta-sh/admin-presentation` holds the pure presentation primitives both surfaces share.
- **Every capability is declared explicitly.** The plugin's only egress is `ctx.http` +
  `allowedHosts` (email is not egress: it goes through the host's `ctx.email`, ADR-0031),
  and its state lives only in what the host injects — `ctx.storage` for
  commerce truth (ADR-0018), `ctx.kv` for settings — nothing else. A test/CI check guards
  that the plugin has no other network or DB surface.
- Any storefront/admin UI string is localized and RTL-safe (logical Tailwind classes),
  same as EmDash.

## 6. Toolchain (mirrors EmDash)

- **pnpm** workspace + `catalog:` for shared version pins.
- **tsdown** builds (ESM + DTS).
- **vitest** for tests; **Playwright** for storefront e2e (`pnpm test:e2e`).
  - **`OTTA_E2E_STRIPE_OFFLINE=1`** (issue #378) arms a dev-only offline Stripe gateway, so an
    e2e stack with no Stripe account can create orders. Orders get an unpayable `pi_<orderId>`
    handle and are paid only by a signed test webhook (`sites/staging/scripts/seed-e2e-orders.ts`,
    which signs with the fixed secret `whsec_e2e_offline`). It works only under `astro dev`;
    `astro build` refuses to run with it set. **Never expose such a dev server publicly:** with
    the published webhook secret anyone can mark orders paid, and EmDash's dev-bypass signs
    anyone in as admin. Bind it to loopback.
- **oxfmt** formatting — **tabs**, run regularly.
- **oxlint** type-aware for linting; keep it clean.
- **TypeScript:** strict, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`. Internal imports use `.js` extensions; type-only imports use
  `import type`.
- Backwards compat matters pre-1.0: prefer additive changes; a break is called out in the
  PR description. **Migrations are forward-only.**

## 7. The edit loop

Same cadence as EmDash:

- `lint` (quick) after every edit.
- `typecheck` after each round of edits.
- `format` regularly.
- Before a PR: **tests pass, lint clean, formatted.**

## 8. Scope discipline

No drive-by refactors, no "while I'm here" edits in unrelated packages. A systemic issue
gets its own change (and, if it's a decision, an ADR under `adr/`). Keep the domain pure,
keep the seams thin, keep each PR to one thing.
