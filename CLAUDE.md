# CLAUDE.md — Otta

Operational guide for Claude working in this repo. The **why** lives in
[`DEVELOPMENT.md`](./DEVELOPMENT.md) (development practices) and [`README.md`](./README.md)
(architecture); read those first. This file is the quick, agent-facing contract: commands,
conventions, and the guardrails that must not be crossed.

> **Status: pre-scaffold.** Design is fully specified; implementation not yet started. The
> toolchain commands below are the **intended** ones (per `DEVELOPMENT.md` §6) — a package
> may not be wired until scaffolding lands. When a command doesn't exist yet, say so rather
> than inventing output.

---

## Non-negotiables

These are build-breaking, not code-review nits (see `DEVELOPMENT.md` for the full rules):

- **TDD, contract-first.** Failing test → code → green → refactor. For anything in
  `@otta-sh/domain`, the behavioral test is written against the **port interface** before any
  adapter. The headline contract is **no oversell under concurrency**.
- **Money is integer minor units, never floats.** A `number` reaching a money field is a type
  error. Branded types (e.g. `Cents`) carry an explicit currency.
- **Ports-and-adapters purity.** `@otta-sh/domain` imports nothing with IO — no `pg`, `ctx`, or
  `fetch`. The boundary is enforced by a dependency check wired into `lint`.
- **Real databases, never mocks.** SQLite (better-sqlite3) is the fast local default; Postgres
  runs in CI. The **concurrency / no-oversell test is Postgres-required** (SQLite can't race).
- **Idempotency in the domain.** Every command carries an `idempotencyKey`; the store enforces
  once-only. Test the replay case.
- **Orders snapshot price + title at purchase time.** Editing a product never rewrites an
  existing order's line items.
- **The plugin is sandbox-clean.** Dev/test against the workerd-on-Node sandbox; Block Kit
  widgets (not React); the plugin reaches the service **only** via `ctx.http` + `allowedHosts`.

## Toolchain & the edit loop

pnpm workspace · tsdown builds · **vitest** tests · **oxfmt** (tabs) · **oxlint** (type-aware) ·
strict TypeScript (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`; internal imports use
`.js`, type-only imports use `import type`).

```bash
pnpm lint         # quick — run after every edit (includes the domain-purity dep check)
pnpm typecheck    # after each round of edits
pnpm test         # vitest; run frequently while implementing
pnpm format       # oxfmt, tabs — run regularly
```

Before a PR: **tests pass, lint clean, formatted, changeset added** if a published package
changed. Migrations are forward-only.

## Branch & commit conventions

- **Branch:** `<type>/<slug>` — type ∈ `feat` `fix` `chore` `docs` `refactor` `test`.
- **PR / commit title tag** — pick the tag for the changed area (don't use interchangeably):

  | Area changed | Tag |
  |---|---|
  | `@otta-sh/domain` (ports, use-cases, invariants) | `[Domain]` |
  | `@otta-sh/service` (REST API, HTTP serialization) | `[Service]` |
  | Store/client/payment **adapters** (postgres, sqlite, d1, stripe, x402) | `[Adapters]` |
  | The EmDash **plugin** (storefront, Block Kit panel, sync hooks) | `[Plugin]` |
  | `sites/*` (the reference storefront site/theme) | `[Site]` |
  | Shared test/contract packages | `[Test]` |
  | CI / tooling / build | `[CI]` |
  | `adr/`, `*.md`, docs | `[Docs]` |

- **Scope discipline:** one PR = one thing. No drive-by refactors. A systemic change or a
  decision gets its own change and, if it's a decision, an **ADR under `adr/`** (see
  `adr/README.md`).

## Verification before merge

Every task is verified end-to-end before the PR is handed over (default, not opt-in):

- **Domain / adapter / service tasks** — the **contract suite is the spec**. A change is done
  when its behavioral suite is green against every relevant adapter. Run the no-oversell
  concurrency test **against Postgres** (`better-sqlite3` verifies the SQL, not the race).
  Record the passing run in the PR.
- **HTTP tasks** — the same client-side contract suite runs against `HttpCommerceClient` over
  a live test server; the wire format must not drift from the port.
- **Plugin / storefront-UI tasks** — exercise against the **workerd-on-Node sandbox** (not
  trusted in-process mode) and, once storefront e2e exists, drive it with Playwright and
  attach a screenshot to the PR.

## Worktrees & multi-agent work

For parallel or agent-driven work, use one git worktree per task, branched from fresh
`origin/main`:

- **Worktree convention:** siblings named `../otta-wt-<slug>`.
- **Branch types & PR tags:** as above.
- **Verification policy:** as above — the contract suite is the gate; never mark a task done
  while tests fail; **never push to `main`**, merging is user-gated.
