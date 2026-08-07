---
"@otta-sh/service": patch
---

Otta ships as two container images, so it can be deployed to anything that runs
containers — including a hosting platform's "Deploy from GitHub", whose build contract is
a `Dockerfile` at the repo root serving on `PORT` and configured entirely from the
environment. Neither image existed before: the only deployable shapes were a Cloudflare
Worker pair and a Node process run by hand from a checkout. DEPLOYMENT.md §3bis is the
runbook.

- **`Dockerfile.service` — the commerce service.** A self-contained bundle: the runtime
  stage carries one `index.mjs` and no `node_modules` at all. That is `tsdown.container.
  config.ts`, a second build that inlines every dependency where the published build
  externalizes them. It has to: running the published `dist/index.mjs` from a checkout is
  issue #44 — the workspace `exports` maps of `@otta-sh/domain` and
  `@otta-sh/store-postgres` point at TypeScript source, so externalized bare imports
  resolve to `.ts` files and Node exits with `ERR_MODULE_NOT_FOUND`. **#44 is not fixed by
  this**; the published artifact is untouched, and a container simply does not consume it.
- **The Node entry stopped importing the sqlite barrel.** `src/index.ts` now imports
  `@otta-sh/store-postgres/pg`, the sqlite-free subpath `src/worker.ts` has always used.
  The barrel re-exports `makeSqliteDb`, which statically pulls in the `better-sqlite3`
  native addon — through it the image would need a C++ toolchain to install and the
  bundler could not bundle a `.node` binary at all. This entry has always been
  postgres-only (it throws without `PG_CONNECTION_STRING`), so nothing it can reach
  changed. Pinned by `test/container-entry.test.ts`, because the failure only ever
  appears in an image build.
- **Root `Dockerfile` — the storefront.** `sites/staging` gained a second build target,
  selected by `OTTA_SITE_TARGET` at build time: `node` swaps the Astro adapter for
  `@astrojs/node`, the content database for Postgres and media storage for S3, and
  changes nothing else. `cloudflare` remains the default, so every existing Worker deploy
  and every existing assertion takes the unchanged path — pinned explicitly, since a
  silent default flip would reshape the live deploy with no call site changing. An
  unrecognised value throws rather than falling back: a typo'd target would otherwise
  build a Cloudflare bundle bound to D1 and R2 bindings that do not exist in a container.
- **`server/cluster.mjs` reconnects `DATABASE_URL`.** The emdash integration serializes
  the database descriptor at BUILD time, inside an image build that has no database, and
  `createDialect()` has no runtime environment fallback — so the built server cannot see
  `DATABASE_URL` by itself. Baking one in would be wrong anyway: QA and production run the
  same image tag against different databases. The entrypoint translates it into the `PG*`
  variables `pg` falls back to, before forking `WEB_CONCURRENCY` workers. An explicit
  `PGHOST` disables the translation entirely, and `sslmode` survives it, which is what
  makes an RDS certificate chain reachable.
- **The plugin half is target-agnostic and stays that way.** Both descriptors, the theme,
  the pages and the `/cart/*` cookie shim are identical on Workers and in a container —
  the plugin only ever talks HTTP — and a test asserts the two targets register the same
  descriptor set rather than leaving that to convention.

Verified end to end: both images build; the service image answers `/health` against a real
Postgres; the store image boots on the Node adapter, derives `PG*` from `DATABASE_URL`,
runs the 47 CMS migrations into Postgres and serves the setup wizard.
