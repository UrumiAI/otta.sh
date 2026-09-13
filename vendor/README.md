# Vendored EmDash host build

Otta's commerce data lives on the EmDash plugin-storage API. The conditional-write
primitives it needs — `updateIf`, `getVersioned`, `compareAndSet`, `compareAndDelete` — are
only partly released: `updateIf` is merged into upstream `main`, while the revision-based
conditional writes are still an open pull request. Rather than wait for a release or ship a
reference implementation that would immediately drift, the repo vendors a **locally built
merge of the two**, packed as four tarballs and committed here.

These tarballs are a build of upstream's own code. They are not a fork of it: the merge
branch carries the merge, its conflict resolutions, and one fix-up the merge itself made
necessary — nothing else. `pnpm` records a sha512
integrity hash for each tarball in the lockfile, so `rm -rf node_modules && pnpm install
--frozen-lockfile` reinstalls them reproducibly, including in CI.

`vendor/` is temporary. It is deleted once a release carrying the conditional writes exists
and the overrides in `pnpm-workspace.yaml` point at that release instead.

## What is in the build

| | |
|---|---|
| Base | upstream `main` at `ea2ccd548f7aba9883bc1c9d0cf3c6f642c10a62` (package version `0.37.0`; already carries `updateIf`) |
| Merged onto it | the conditional-write pull request, head `c4b441b05221d936e62a28e2c33214912a7a231a` |
| Merge commit | `39ff8569c914853fa7fde1720632caa6ba4ac91c` |
| Branch head the tarballs are built from | `2dc708318d358631ab0620aded3d2afc0bac6de9`, on branch `otta/emdash-cas` — the merge plus one post-merge fix-up: the keep-both import-list resolution left an unused type import behind, which the host's own `oxlint --type-aware --deny-warnings` rejects |
| Migration number used | `077_plugin_storage_revisions` |
| Tarball version | `0.37.1-otta.1` — the base version's patch bumped and suffixed, so it can never be mistaken for a published release |

The merge branch is pushed to the project's own fork of the CMS repository — the branch head
above, never force-pushed, because it is what the tarballs were built from — so the build is
reproducible from the commits above by anyone with this repo rather than only from a local
clone. Nothing is proposed upstream: no pull request is opened and no upstream branch
is written to.

## Tarballs, and why each one is here

| Package | Size | Why it is vendored |
|---|---|---|
| `emdash-0.37.1-otta.1.tgz` | 3.9 MB | the primitives themselves |
| `emdash-cms-admin-0.37.1-otta.1.tgz` | 5.0 MB | **required, not optional.** The core build imports `@emdash-cms/admin/portable-text-table`, and the published `0.37.0` admin does not export that subpath at all — its exports map has only `.`, `./styles.css`, `./locales`, `./locales/*` and `./slugify`. Installing the stock admin alongside the vendored core makes the core package fail to resolve. |
| `emdash-cms-cloudflare-0.37.1-otta.1.tgz` | 245 KB | the Worker bridge, which must be the copy that knows about the conditional-write operations |
| `emdash-cms-registry-client-0.5.1-otta.1.tgz` | 129 KB | **required for the same reason as the admin package.** The core build imports `isProvenFirstRelease` from this package's `listing-policy` subpath, and the published `0.5.0` — the exact version the core build asks for — does not export it. Without this tarball, importing the root `emdash` entry throws `SyntaxError: ... does not provide an export named 'isProvenFirstRelease'`. |

Every other sibling package (`@emdash-cms/auth`, `gutenberg-to-portable-text`,
`plugin-types`, `registry-lexicons`, `registry-verification`) matches its published release
and resolves from the registry normally.

The pattern behind the admin and registry-client entries is worth stating once: the host
monorepo's workspace packages can carry source that is newer than the release their
`package.json` version names, and the core build links against the workspace copy. Any
sibling whose unreleased source the core build reaches has to be vendored alongside it.
Importing the root `emdash` entry is the cheap way to find them — a missing one surfaces as
an unresolved named import at module-instantiation time, not at install time.

## Why the overrides are load-bearing

Two of the overrides fail loudly if they go, and one fails quietly. The loud ones are
`emdash` and `@emdash-cms/admin`: the vendored tarballs cross-pin each other at
`0.37.1-otta.1` and `0.5.1-otta.1`, versions that do not exist on the registry, so removing
either override leaves a specifier nothing can satisfy and the install stops.

The quiet one is `@emdash-cms/cloudflare`. The published `0.37.0` of it depends on an
**exact** `emdash` version, which the registry can satisfy — so without that override a
second, stock `emdash` lands in the store and the Worker bridge binds to the copy
**without** the primitives: no install error, no type error, just missing methods at
runtime. That is the failure mode the one-copy assertion exists for, and it is asserted in
the repo by `sites/staging/test/host-pin.test.ts`.

The overrides must live in `pnpm-workspace.yaml`: pnpm 11 ignores `pnpm.overrides` in
`package.json` without warning. The pins must never float — no `^`, no `~`: a stray
`emdash@1.0.0` exists on npm and is not the latest release of this host.

Package manifests keep plain `"0.37.0"` specifiers, so moving off the vendored build later
is an override edit rather than a manifest sweep.

## Conflict resolutions in the merge

`otta-emdash-cas.diff` next to these tarballs is the machine-readable record: it is
`git diff <base> <branch head> -- packages/`, so `git apply --check` against a future base
answers "do the recorded resolutions still apply?" without a clone of the merge branch.
`scripts/vendor-emdash.sh` runs exactly that check on the path where the recorded head is
unreachable. The prose below is the same information in a form a reader can argue with.

Both sides add methods to the same storage surfaces, so almost every conflict is "keep both".

1. **Migration-number collision (the load-bearing one).** The pull request adds
   `076_plugin_storage_revisions`; the base already ends at `076_collection_nav_group`. The
   migration was renumbered to **`077_plugin_storage_revisions`** — the file, its three `.ts`
   importers, and the runner's import alias and map key. Re-check the next free number if
   the base has grown more migrations, and record whatever number is actually used here.
2. **Type re-exports** (core's root and plugin entries, and the plugin-storage repository):
   keep both sides' exported type names.
3. **The sandbox bridge protocol, host implementation and in-sandbox wrapper**, for both the
   Cloudflare and the workerd runtimes: keep both sides' operations.
4. **The migrations integration test**: take the pull request's form, which slices the
   runner's exported migration-name list instead of restating the tail by hand — it does not
   need editing when a migration is added.
5. **The workerd integration test**: keep both sides' cases as two separate tests. A textual
   "keep both" interleaves them into one broken block, because both sides add a case in the
   same place with the same surrounding shape.
6. **The base's D1 `updateIf` test builds its storage table by hand** and now needs the
   `revision` column the merged repository writes on every write. One added column, matching
   what the pull request did to its own fixtures.
7. **The storage documentation page**: keep both sections.
8. **One post-merge fix-up, not a conflict resolution.** The keep-both on the Cloudflare
   sandbox bridge's `import type … from "emdash"` list produces a `NumericDelta` import that
   neither parent uses, and the host lints with `--deny-warnings`, so the merge commit itself
   does not lint even though both of its parents do. The fix is the one commit on top of the
   merge — which is why this file records a branch head as well as a merge commit, and why
   the build script reuses the recorded **head**.

## Node, and wrangler

`engines.node: ">=22.16"` is the host's own floor. The rule in this repo is: the root
manifest declares it, and so does every manifest that resolves the host
(`sites/staging`, `packages/admin-react`) — no other package restates it, and CI pins the
major line only (`node-version: "22"`), which satisfies the floor without narrowing to one
minor.

The `wrangler` catalog entry moved `^4.68` → `^4.99` because the vendored
`@emdash-cms/cloudflare` declares `peerDependencies.wrangler >= 4.99.0`.

## Rebuilding

```bash
scripts/vendor-emdash.sh <base-main-sha> <pr-head-sha> <path-to-an-emdash-clone>
```

Roughly four minutes: fetch, reuse-or-redo the merge, install, build, version, pack. What it
asserts on the way through, because each of these has already been got wrong once: that the
recorded branch head is reachable and has the recorded merge on its first-parent chain with
exactly the requested commits as parents (otherwise it re-merges, after telling you whether
`otta-emdash-cas.diff` still applies); that no two migrations share a numeric prefix, since the
collision this merge resolves is semantic rather than textual and an auto-merge can "succeed"
with two `076`s; and that the packed core's `dist` really mentions the four primitives and the
renumbered migration. The install is frozen-only, with no unpinned fallback — a fallback would
let the dependency closure bundled into the tarballs drift between runs of a script whose whole
purpose is reproducing one build.

Re-run it whenever either commit moves, re-check the free migration number, update the SHAs and
the figures above, run the host's own `oxlint --type-aware --deny-warnings` on the result, and
re-run the full test battery — the vendored host is a dependency every package in the repo
transitively imports.

## R13 — the migration-name hazard, and the fast path that hides it

The renumbering above is recorded as risk **R13** in the work order: if upstream eventually
lands the conditional-write migration under a number other than `077`, a database migrated by
this build carries a migration name the released runner does not know, and Kysely requires a
contiguous known prefix. Staging is the only database that can reach that state before the
swap, and it is demo data that is re-seeded anyway.

There is a sharper edge on the same risk, and it is the one that can pass unnoticed.
`runMigrations` short-circuits on `appliedCount >= MIGRATION_COUNT` — 76 in this build. A
database migrated by this build holds 76 rows, one of them
`077_plugin_storage_revisions`. When the pin later moves to a stock release that also has 76
migrations, that fast path returns "nothing to do" — and upstream's **real** `077`, whatever
it turns out to be, is silently never applied. No error, no pending list, a database missing
a migration the runner believes it has.

## De-vendoring checklist

What has to happen when `vendor/` is deleted in favour of a published release (this section
is what that increment reads):

1. Point the four overrides in `pnpm-workspace.yaml` at the released versions, delete the
   tarballs, `otta-emdash-cas.diff` and this file, and drop `scripts/vendor-emdash.sh`.
2. Move the `emdash` / `@emdash-cms/cloudflare` specifiers in the manifests only if the
   released version differs from the `0.37.0` they already name.
3. **Reconcile every database migrated by this build before the new host ever runs against
   it.** Renaming `077_plugin_storage_revisions` to whatever upstream shipped is not
   optional and cannot be deferred to "the runner will sort it out": see the fast path
   above, which will report nothing pending either way. Compare the applied rows against the
   new build's `MIGRATION_NAMES` by NAME, not by count.
4. Re-run the full battery, and keep `sites/staging/test/host-pin.test.ts` — with its tail
   migration name and its one-copy assertion updated to the released build — rather than
   deleting it. It is the thing that notices a second `emdash` returning.

## Build evidence

Recorded on this base: the host's own storage, conditional-write, no-oversell and migration
suites pass on SQLite and on Postgres, its Worker-runtime sandbox suites pass, and a
throwaway consumer confirms the migrations apply with `077_plugin_storage_revisions` as the
tail and that all four primitives behave as documented, including the stale-revision
refusals. Figures are recorded in the pull request that introduced this directory.

One test in the host's own `@emdash-cms/cloudflare` package is worth naming because it is
sometimes red: `tests/db/d1-migration-target.test.ts` — "uses project-local Wrangler and
preserves account inheritance for a named environment" — spawns a real `wrangler` process and
times out against the suite's 5s default when the machine is loaded. On this branch head, with
every host package built, the package is green end to end (432 passed, 2 skipped); the failure
reproduces only under load. It is upstream's test, it does not touch the primitives, and
nothing Otta ships depends on it, so a red run of it is discounted rather than chased.
