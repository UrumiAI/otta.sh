# Contributing to Urumi

Thanks for your interest in contributing. This is a quick, practical guide to getting set
up and sending a change. The **why** behind these rules lives in
[`DEVELOPMENT.md`](./DEVELOPMENT.md) and [`CLAUDE.md`](./CLAUDE.md) — read those for the
full depth; this file only summarizes what you need to open a PR.

## Prereqs

- Node 22
- pnpm — the workspace pins `packageManager: pnpm@11.10.0` in the root `package.json`; use
  that version (via Corepack) rather than whatever `pnpm` you have globally.

## Setup

```bash
pnpm install
```

## The edit loop

Run these after every edit, and again before opening a PR:

```bash
pnpm lint         # oxlint + the domain-purity dependency check
pnpm typecheck
pnpm test         # vitest
pnpm format       # oxfmt, tabs
```

## TDD, contract-first

The order is always: **failing test → code → green → refactor.** For anything in
`@urumi/domain`, write the behavioral test against the **port interface** before writing any
adapter — the headline contract is *no oversell under concurrency*. See
[`DEVELOPMENT.md` §1](./DEVELOPMENT.md#1-tdd-is-contract-first) for the full rule.

## Real databases, never mocks

No DB mocks. SQLite (`better-sqlite3`) is the fast local default for the contract suite;
Postgres is required for the concurrency/no-oversell test (`pnpm test:pg`) since SQLite
can't exercise a real race. See
[`DEVELOPMENT.md` §2](./DEVELOPMENT.md#2-real-databases-never-mocks).

## Money is integer minor units

Amounts are branded integer types (e.g. `Cents`) carrying an explicit currency — a `number`
reaching a money field is a type error. See
[`DEVELOPMENT.md` §4](./DEVELOPMENT.md#4-commerce-invariants-rules-emdash-doesnt-need) for
the full set of commerce invariants.

## Branch naming

`<type>/<slug>`, where `type` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

## Commit / PR title tags

Pick the tag for the area your change touches:

| Area changed | Tag |
|---|---|
| `@urumi/domain` (ports, use-cases, invariants) | `[Domain]` |
| `@urumi/service` (REST API, HTTP serialization) | `[Service]` |
| Store/client/payment **adapters** (postgres, sqlite, d1, stripe, x402) | `[Adapters]` |
| The EmDash **plugin** (storefront, Block Kit panel, sync hooks) | `[Plugin]` |
| Shared test/contract packages | `[Test]` |
| CI / tooling / build | `[CI]` |
| `adr/`, `*.md`, docs | `[Docs]` |

## Scope discipline

One PR = one thing. No drive-by refactors. A systemic change — or anything that's really a
decision rather than a mechanical change — gets its own PR and, if it's a decision, an
**ADR under `adr/`** (see [`adr/README.md`](./adr/README.md)).

## Before opening a PR

- Tests pass, lint is clean, code is formatted.
- A changeset is added if a published package changed — run `pnpm changeset` to generate
  one.

## Reporting issues

- **Security vulnerabilities:** do not open a public issue — see
  [`SECURITY.md`](./SECURITY.md) for private disclosure instructions.
- Everything else: open a GitHub issue, or a PR directly if you already have a fix.

Please also read our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
