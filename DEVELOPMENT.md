# Urumi — Development Practices

_How we build Urumi. Read this before writing code._

Urumi is a standalone repo (its own git history, its own pnpm workspace) that
**mirrors [EmDash]'s conventions** without inheriting its config. Where EmDash has a
practice that fits a commerce service, we copy it. Where commerce needs more (money,
concurrency, idempotency), we add rules EmDash doesn't have.

[EmDash]: https://github.com/emdash-cms/emdash

---

## 1. TDD is contract-first

The order is always: **failing test → code → green → refactor.** A behavior without a
reproducing test is not done, and a bug without a reproducing test is not fixed.

Urumi's stronger rule: **the contract test suite is the spec.** For anything in
`@urumi/domain`, write the behavioral test against the **port interface** before writing
any adapter. The adapter is "done" the day it turns that suite green — nothing else counts
as done.

- **Headline contract:** _no oversell under concurrency._ Fire N concurrent `reserve`s at
  stock M (M < N); assert **exactly M** succeed and the rest get `OUT_OF_STOCK`. Written
  once, run against every `InventoryStore` adapter.
- One behavioral suite lives in the domain (or a shared test package) and runs against
  **every** store adapter — Postgres today, EmDash later. This mirrors EmDash's
  `describeEachDialect`.

## 2. Real databases, never mocks

No DB mocks, ever — same as EmDash. A mocked store can't catch the races and constraint
violations that are the entire point of the commerce service.

- **SQLite (better-sqlite3) is the fast default.** Every contract test runs on it locally;
  no setup, sub-second.
- **Postgres runs in CI** and is opt-in locally via env (per-test schema isolation, real
  `pg` connection).
- **The concurrency test is Postgres-required.** `better-sqlite3` serializes writes in one
  process, so it cannot exercise a real race — it verifies the _SQL is correct_, not that
  it's _race-safe_. Mark the no-oversell test to run only against Postgres (and D1 later),
  and say so in the test name.

Both dialects run the single-statement atomic write unchanged:

```sql
UPDATE inventory SET on_hand = on_hand - :q WHERE sku = :s AND on_hand >= :q RETURNING on_hand;
```

If a write can't be expressed as one conditional statement, it doesn't belong behind the
store port — no `SELECT … FOR UPDATE`, no interactive transactions (D1 has neither).

## 3. Ports-and-adapters purity is enforced, not trusted

`@urumi/domain` depends on **nothing with IO**. A `pg`, `ctx`, or `fetch` import in the
domain is a build-breaking bug, not a code-review nit.

- Enforce the boundary with a dependency check (dependency-cruiser or an import-restriction
  lint rule) wired into `lint`, so the layering can't rot silently.
- **HTTP mirrors the port 1:1.** The REST API in `@urumi/service` is a serialization of the
  domain use-cases — no endpoint has semantics the port lacks, no status-code-as-logic. The
  same client-side contract suite runs against `HttpCommerceClient` (over a live test
  server) so the wire format can't drift from the port.
- **Add an adapter only when a second real implementation exists.** No speculative
  `EmdashStore` / `InProcessCommerceClient` before the EmDash primitive ships.

## 4. Commerce invariants (rules EmDash doesn't need)

- **Money is integer minor units. Never floats.** Amounts are branded integer types (e.g.
  `Cents`) carrying an explicit currency; a `number` that reaches a money field is a type
  error. No float ever touches a price, tax, or total.
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
- **Block Kit widgets, not React** (React widgets are trusted-only). The "Product data"
  panel is Block Kit `elements`.
- **Every capability is declared explicitly.** The plugin reaches the service _only_ via
  `ctx.http` + `allowedHosts` — nothing else. A test/CI check guards that the plugin has no
  other network or DB surface.
- Any storefront/admin UI string is localized and RTL-safe (logical Tailwind classes),
  same as EmDash.

## 6. Toolchain (mirrors EmDash)

- **pnpm** workspace + `catalog:` for shared version pins.
- **tsdown** builds (ESM + DTS).
- **vitest** for tests; **Playwright** for storefront e2e when we get there.
- **oxfmt** formatting — **tabs**, run regularly.
- **oxlint** type-aware for linting; keep it clean.
- **TypeScript:** strict, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`. Internal imports use `.js` extensions; type-only imports use
  `import type`.
- **Changesets** once packages publish. Backwards compat matters pre-1.0: prefer additive
  changes; a break needs a bump + a changeset that calls it out. **Migrations are
  forward-only.**

## 7. The edit loop

Same cadence as EmDash:

- `lint` (quick) after every edit.
- `typecheck` after each round of edits.
- `format` regularly.
- Before a PR: **tests pass, lint clean, formatted, changeset added** if a published
  package changed.

## 8. Scope discipline

No drive-by refactors, no "while I'm here" edits in unrelated packages. A systemic issue
gets its own change (and, if it's a decision, an ADR under `adr/`). Keep the domain pure,
keep the seams thin, keep each PR to one thing.
