# Work order 02 — fold the commerce service into the plugin: memory note

The durable record of what work order 02 did, what it measured, and what it deleted. The
forward-looking document it closes out is
[`work-order-02-fold-service-into-plugin.md`](./work-order-02-fold-service-into-plugin.md); this
file is the backward-looking one. It exists because the plan's own definition of done (item 13)
asks for it: the outcome, the measured numbers behind R2/R3/R6/R7, the pinned host SHAs and
migration number, the conflict resolutions, what was deleted, and whatever INC-D6 has to
reconcile.

Every figure below is cited to the artefact it was read from. Where a number the plan asked for
was not found recorded anywhere, this note says so rather than supplying a plausible one — an
invented number in a historical record is worse than an acknowledged gap.

---

## 1. The outcome

**One deployable.** The EmDash site Worker is the only thing that ships. The Otta plugin owns all
money and stock truth **in-process**, on the host's per-plugin document store (`ctx.storage`),
through the `@otta-sh/store-emdash` adapter — one document per aggregate, compare-and-set writes.
There is no separate commerce service, no second database, and no second mode.

Deleted outright in Phase D: `@otta-sh/service`, `@otta-sh/store-postgres`, `HttpCommerceClient`,
the four admin HTTP clients, and the `commerce.mode` flag. Details in §4.

The decision itself is recorded in
[ADR-0020](../adr/0020-one-deployable-plugin-owns-commerce-truth.md) (one deployable; ADR-0002 is
partially superseded by it), resting on
[ADR-0018](../adr/0018-plugin-owns-commerce-truth-in-process.md) (the plugin owns commerce truth
in-process) and [ADR-0019](../adr/0019-commerce-aggregates-are-one-document-each.md) (one document
per aggregate). ADR-0020 also records the re-derivation path: a future service would be rebuilt
from the unchanged domain ports, not kept on standby, so the deletion is not mistaken for a lost
capability.

**The price paid, not just the wins.** The fold-in accepted one genuine loss, and ADR-0020 §2
records it rather than minimising it: the Stripe API secret — previously an environment variable on
a separate Worker, behind an HTTP boundary — now lives in the plugin's write-only `kv` and is
readable inside the very process that renders storefront pages and the admin console, so a
code-execution bug anywhere in the plugin reaches it. Read
[ADR-0020 §2](../adr/0020-one-deployable-plugin-owns-commerce-truth.md) for what bounds that
(write-only persistence, non-ambient egress gated by a build-time `allowedHosts` allowlist, an
IO-free domain) and for its honest caveat: `@otta-sh/payments-stripe` defaults its transport to
`globalThis.fetch` rather than `ctx.http.fetch` — unlike the x402 facilitator client and the email
sender — so the allowlist bound does not yet apply to it; the secret is stored but no live call
site constructs the Stripe gateway with a real transport, which makes this latent rather than
exploited, and makes passing `ctx.http.fetch` mandatory for whoever wires it up.

---

## 2. The measured numbers (R2, R3, R6, R7)

### R2 — CAS contention and the retry budget

R2 has **no structural fix**: a hot aggregate is written by read-modify-write, so a hot SKU
retries. That makes the measured retry depth a **permanent contention budget**, not an interim
figure — which is why the plan requires it to be repeated here.

The constants, from `@otta-sh/store-emdash`:

| Constant | Value |
|---|---|
| `CAS_MAX_ATTEMPTS` (package ceiling) | **24** (raised from 12 on 2026-09-14) |
| `CAS_ATTEMPT_BUDGET` (hand-set test budget, deliberately tighter) | **8** |
| Backoff | full-jittered, first delay **2 ms**, doubling to a **50 ms** cap (`CAS_MAX_DELAY_MS`) |

Measured depths:

| Shape | Measured attempts |
|---|---|
| Inventory flash sale — 5 units, 50 racers, 20 loops | **5–6** |
| Inventory — 1 unit, 100 racers | **2** |
| Single-line checkout — M=5, N=40, 8 loops | **6–7** |
| Multi-line checkout — M=8/sku, 10 carts, 3 lines, 6 loops | **9–10** of 24 |
| Ten partial refunds under one ceiling — N=20 callers, 100 each against 1,000, injected gateway latency | **11** |
| Restock +10 racing 40 reserves on 5 units | **13** of 24 |
| Restock then 40 reserves on 15 units (sequenced) | **12** of 24 |
| 20 removals racing 20 reserves on 12 units, 15 loops | **15** of 24 (the deepest recorded shape — see the exception below) |
| Full-ceiling refund shapes | **2** (losers are refused by arbitration before writing) |
| Coupon counter step (`redeem`), 50 racers on a 5-use cap | **2** (asserted as a hard bound, `<= 2`) |

**R2's one documented exception.** An adversarial merchant shape — 20 `removeStock` racing 20
reserves on 12 units, 15 loops, 600 calls — is the deepest shape the suite measures. The cause is
that a refused `removeStock` still writes its ledger entry, so writes are not bounded by units the
way reserves are.

**Pre-raise (12-attempt ceiling).** This shape sat *at* the ceiling and raised the typed contention
error, with **11–29** typed contention failures per run. That was the measurement that motivated
raising the ceiling.

**Current (24-attempt ceiling).** The same shape now measures **15 of 24 attempts with 0 typed
contention failures** — two or three attempts deeper, and no caller is told "too busy" any more.
The assertions themselves are unchanged upper bounds and held across the raise without being
touched: depth `<= CAS_MAX_ATTEMPTS`, typed failures **`<= 90`** (15% of the 600 calls).

Both reviewers judged this correctly characterised and not a shopper-safety hole, because the
contention error is typed and retryable and never collapses into `OUT_OF_STOCK`. Two follow-ups
were opened at the time: the
storefront cart route must map `StorageContentionError` to a 503 plus retry, and a later adapter
pass should stop `#applyStockClaim` writing the aggregate for a refused `INSUFFICIENT_STOCK`
removal, which would restore the unit bound on write depth.

The ceiling was raised from 12 to 24 because the refund shape above measured 11 — one attempt
under the old ceiling — which made an exhausted budget a flake rather than a signal. The extra
attempts only buy jittered backoff; no invariant depends on the attempt count, because every
invariant is enforced by the guard inside the write.

Exhaustion surfaces as a typed, retryable `StorageContentionError` — never `OUT_OF_STOCK`. A
shopper who could have bought is never told the item is out of stock.

**Sources:** `packages/store-emdash/README.md` §"Contention budget" and §"Coupon contention,
measured" (the live tables, which is where they are re-measured);
[ADR-0019](../adr/0019-commerce-aggregates-are-one-document-each.md) §"The contention budget, as
numbers". ADR-0019 explicitly defers to the package README for live figures, so cite the README
rather than the ADR's table, which predates the ceiling raise.

### R3 — document size against D1's row limits

Measured on the busiest shape, a three-line order with a full ship-to snapshot, via
`JSON.stringify(doc).length` on the sqlite tier:

| Shape | Size |
|---|---|
| On creation | **2,237 B** |
| After five transitions (five audit events + five outbox entries) | **4,081 B** |
| Plus two captured payments and three refunds | **5,164 B** |
| `order_keys` document, terminal | **109 B** (≈2.3 KB while a claim carrying the payload) |
| `refund_keys` document, terminal | **159 B** (≈400 B while a claim) |

All three order figures are **asserted, not remembered**: `order-flow.dialects.test.ts` builds that
order, prints the sizes, and holds them under an **8 KB cap**. The busiest measured shape is still
under two thirds of the cap, so the cap is unchanged. A row-size regression — an unbounded ledger,
a re-embedded snapshot — fails a test rather than surfacing as a slow read.

Growth is bounded by the state machine rather than by pruning: at most nine transitions per order,
≈370 B per transition (event plus outbox entry), ≈180 B per capture, ≈220 B per refund row.
`events` is deliberately unbounded because it is the audit spine the port promises. The one ledger
with no natural bound — per-order notes — is therefore not in this document at all.

**Honest caveat on the plan's wording:** the plan asked for a **p99** document size. What was
actually measured and asserted is the size of the busiest realistic shape against a hard 8 KB cap,
not a percentile over a population of real orders. That is a stronger guard for a pre-launch system
with no order population to take a percentile over, but it is not literally a p99, and this note
records the distinction rather than relabelling the figures.

**Source:** `packages/store-emdash/README.md` §"Measured document size".

### R6 — Worker bundle size

**PARTIAL — a real before/after number exists from INC-A6, but not the full figure the plan asked
for, and not at INC-B10a where it was supposed to be recorded.**

R6 had two halves. The **correctness** half shipped and is asserted: INC-A6 promoted
`@otta-sh/domain` and `@otta-sh/store-emdash` to `dependencies` of `@otta-sh/plugin` and inlines
both via tsdown `noExternal`, and `packages/plugin/test/bundle-imports.test.ts` builds the real
bundle through the package's own `tsdown.config.ts` and fails if a bare `@otta-sh/*` specifier
survives or a runtime `emdash` import appears (the latter being ADR-0018's "zero EmDash runtime
dependency" rule, which depcruise enforces on source but cannot see in the emitted graph).

The **measurement** half is partial. INC-A6 (PR #252) captured a genuine before/after build:

| | Main chunk | Gzipped | Total dist (14 files) |
|---|---|---|---|
| Base — domain/store-emdash still external | 510.35 kB | 154.60 kB | 1.81 MB |
| Head — both inlined via `noExternal` | 521.40 kB | 158.75 kB | 1.84 MB |
| **Delta** | **+11.05 kB** | **+4.15 kB** | **+30 kB** |

Two caveats that stop this being the answer to R6:

1. **It excludes the payment gateways.** Both were admitted into the plugin's perimeter later, and
   in two separate increments: `@otta-sh/payments-stripe` at **INC-C1b (PR #276)**, which added it
   to `tsdown.config.ts`'s `noExternal` and the workerd harness list, and `@otta-sh/payments-x402`
   at **INC-C5 (PR #281**, commit `5f304d1`**)**, when the in-process x402 settle path made
   `payments/x402-wiring.ts` a real runtime import. No build-size log was captured at either. R6's
   concern is the Worker gaining the domain, `store-emdash` **and both payment gateways**; this
   measures the first two only.
2. **It is a `dist/` build figure, not a deployed Worker figure**, and it is not the INC-B10a
   measurement the plan called for. INC-B10a (PRs #267/#268) recorded no bundle size at all — its
   evidence notes only a generic build stat ("14 files, 3.70 MB"), which is dist output including
   `.d.mts` and `.map` files.

Searched to establish this: every merged PR body from this work order (#246–#293) for "bundle
size", "gzipped", "KiB" and related terms; the run log, whose INC-B10a entries discuss the bundle
*guard* but record no size; `/home/azureuser/otta-work-orders/evidence/` including `inc-a6`,
`inc-b10a-1` and `inc-b10a-2`; and the repo tree's source, ADRs and plans. Other bundle figures in
the tree are unrelated — `sites/staging/src/lib/coil.ts` (6.1 kB per coil, 2.2 kB gzipped),
ADR-0014's +0.19 KiB gzipped for the second native descriptor, and the harness note that the host's
own `PluginRegistry.js` is 7.94 MB raw / 1.90 MB gzipped before any Otta code.

So: the guard that the bundle is *correct* exists and holds; the delta for admitting the domain and
the store adapter is a real +4.15 kB gzipped; but **the total deployed Worker size with the payment
gateways included was never measured or recorded**. Anyone closing this should measure it with
`wrangler deploy --dry-run` on `sites/staging` (what ADR-0014 used) rather than assuming the
absence of a number means the result was fine.

### R7 — D1 write throughput

**NOT FOUND — flagged as an open gap.**

The plan's mitigation reads: "Accepted as the price (D5 reason 5). Record a measured
writes/second figure from the D1 tier so the limit is a number. Pre-launch, this is theoretical;
ADR-0020 records the re-derivation path if it ever stops being."

No writes/second figure was found recorded anywhere. Searched: all merged PR bodies #246–#293
(including INC-A4's PR #250, the real-D1 tier, and INC-D2's PR #285, the D1 tier release gate) for
"throughput", "writes/s" and "writes per second" — zero hits; the run log; the evidence directory;
and ADR-0018/0019/0020, which discuss D1 as the storage floor and its *contention* behaviour as a
measured budget, but state no throughput number.

The D1 tier itself is real and green — INC-A4 recorded 82/82 with no divergence, and it is a hard
gate — so what is missing is specifically the **throughput figure**, not the D1 coverage. The plan
itself notes this is theoretical pre-launch; it becomes real the moment there is traffic, and it is
the only storage ceiling left now that Postgres is gone.

> **Summary of the four:** R2 and R3 have real, asserted, in-repo numbers. **R6 and R7 do not have
> the figure the plan actually asked for** — R6 has a real but incomplete number (a +4.15 kB
> gzipped delta that excludes both payment gateways and was not taken at INC-B10a), R7 has no
> number at all. Both are recorded here as open gaps rather than filled with estimates.

---

## 3. The vendored host build: pinned SHAs, migration number, conflict resolutions

Otta's commerce data needs conditional-write primitives (`updateIf`, `getVersioned`,
`compareAndSet`, `compareAndDelete`) that were only partly released. `updateIf` was merged into
upstream `main` (#2169); the revision-based conditional writes (#2980) were still an open pull
request. Rather than wait for a release or ship a reference implementation that would immediately
drift, the repo vendored a locally built **merge of the two**, packed as tarballs under `vendor/`
with `file:` overrides in `pnpm-workspace.yaml`.

### The pins

| | |
|---|---|
| Base | upstream `main` at **`ea2ccd548f7aba9883bc1c9d0cf3c6f642c10a62`** (package version `0.37.0`; already carries #2169) |
| Merged onto it | #2980, head **`c4b441b05221d936e62a28e2c33214912a7a231a`** |
| Merge commit | **`39ff8569c914853fa7fde1720632caa6ba4ac91c`** |
| Branch head the tarballs were built from | **`2dc708318d358631ab0620aded3d2afc0bac6de9`**, on branch `otta/emdash-cas` |
| Migration number used | **`077_plugin_storage_revisions`** |
| Tarball version | `0.37.1-otta.1` — the base patch bumped and suffixed, so it can never be mistaken for a published release |

The merge branch is pushed to Otta's own fork and never force-pushed, because it is what the
tarballs were built from. Nothing was proposed upstream.

### The conflict resolutions

Both sides add methods to the same storage surfaces, so almost every conflict was "keep both". The
resolutions, in short:

1. **The migration-number collision — the load-bearing one.** #2980 adds
   `076_plugin_storage_revisions`; the base already ended at `076_collection_nav_group`. The
   migration was renumbered to **`077_plugin_storage_revisions`** — the file, its three `.ts`
   importers, and the runner's import alias and map key.
2. **Type re-exports** (core's root and plugin entries, plugin-storage repository): keep both
   sides' exported type names.
3. **The sandbox bridge protocol, host implementation and in-sandbox wrapper**, for both Cloudflare
   and workerd: keep both sides' operations.
4. **The migrations integration test**: take #2980's form, which slices the runner's exported
   migration-name list rather than restating the tail by hand.
5. **The workerd integration test**: keep both sides' cases as two separate tests — a textual "keep
   both" interleaves them into one broken block.
6. **The base's D1 `updateIf` test** builds its storage table by hand and needed the `revision`
   column the merged repository now writes on every write.
7. **The storage documentation page**: keep both sections.

**Plus one post-merge fix-up, which is not a conflict resolution.** The keep-both on the Cloudflare
sandbox bridge's `import type … from "emdash"` list left behind a `NumericDelta` import that
neither parent uses. The host lints with `oxlint --type-aware --deny-warnings`, so the merge commit
itself does not lint even though both of its parents do. The fix is the one commit on top of the
merge — which is why the build records a **branch head** as well as a merge commit, and why the
build script reuses the recorded head.

### The migration-name hazard (R13)

Recorded because it outlives the vendoring. If upstream eventually lands the conditional-write
migration under a number other than `077`, a database migrated by this build carries a migration
name the released runner does not know. The sharp edge is that `runMigrations` short-circuits on
`appliedCount >= MIGRATION_COUNT`: a database migrated by this build holds 76 rows, one of them
`077_plugin_storage_revisions`, so when the pin moves to a stock release that also has 76
migrations, the fast path returns "nothing to do" and upstream's real `077` is **silently never
applied**. Applied rows must be compared by **name**, not by count. Staging is the only database
that can reach that state, and it is re-seeded demo data.

> **Where the detail lives now.** `vendor/README.md` held the full record behind this section — the
> tarball inventory and why each was required, why each override was load-bearing, and the
> de-vendoring checklist. INC-D6 deleted `vendor/`, and that content is folded into **§6**. §5 is
> what the release swap settled, R13 included.

---

## 4. What was deleted, and by which increment

| Increment | PR | What went |
|---|---|---|
| **INC-D3a** | [#288](https://github.com/UrumiAI/otta.sh/pull/288) — *[Plugin] Retire commerce service Worker deployment surface* | The service Worker's whole deployment surface: wrangler config, deploy scripts, service-mode identifiers, the service-token settings UI, and the DEPLOYMENT.md section covering it — including the **`commerce.mode` flag** (`__OTTA_COMMERCE_MODE__`). Removing the mode plumbing made the conditional in `makeCommerceClient`/`makeAdminClients` dead, so those collapsed to unconditional in-process here rather than in D3b. |
| **INC-D3b** | [#290](https://github.com/UrumiAI/otta.sh/pull/290) — *[Adapters][Plugin][Test] Delete packages/service and packages/store-postgres* | **`@otta-sh/service`** and **`@otta-sh/store-postgres`** deleted entirely, plus **`HttpCommerceClient`**, the **four admin HTTP clients** — `AdminOrdersClient`, `AdminProductsClient`, `AdminRulesClient`, `ReportingSettingsClient` — and their tests, `helpers/start-live-service.ts`; `commerceClientContract` collapsed to a single in-process tier; six dead public exports dropped from `@otta-sh/plugin`'s index. |
| **INC-D3c** | [#292](https://github.com/UrumiAI/otta.sh/pull/292) — *[CI][Docs] Trim stale service/store-postgres references from tooling and docs* | Stale references left behind by D3b, in `.dependency-cruiser.cjs`, `depcruise-boundary.test.ts`, `CLAUDE.md`, `CONTRIBUTING.md` and `DEVELOPMENT.md`. **The `CLAUDE.md` sweep was partial** — its lines 37, 52 and 95 still describe the service and `HttpCommerceClient` as live, as do `packages/plugin/README.md` and `packages/plugin/test/contracts/README.md`; see §4 "Verified absent" for the open follow-up. |
| **INC-D4** | [#293](https://github.com/UrumiAI/otta.sh/pull/293) — *[Docs] One deployable: describe the current architecture in README, DEPLOYMENT.md, and a new ADR* | Not a deletion: rewrote `README.md` and `DEPLOYMENT.md` for the one-deployable architecture, added **ADR-0020**, marked ADR-0002 partially superseded, updated the ADR-0018/0019 forward-references and the `adr/` index. |

What licensed the D3b deletion was the equivalence proof built **across INC-B10a → INC-B10c**, not
at any single increment: `commerceClientContract` — the spec, extracted from the HTTP client's own
tests — ran green against both implementations before the HTTP tier was removed. It had to be built
incrementally because INC-A7 found the premise weaker than the spec assumed: of the 165 assertions
in the eight HTTP-client test files, only **28 were transport-agnostic**; the rest were HTTP wire
mapping. So each increment added its own slice — INC-B10a (PRs #267/#268, the storefront slice,
26→53 cases per tier), INC-B10b-i/ii (the admin products and orders slices), INC-B10c-i
([#272](https://github.com/UrumiAI/otta.sh/pull/272), the admin rules slice, widening the shared
surface from 18 to all 25 methods) and INC-B10c-ii
([#273](https://github.com/UrumiAI/otta.sh/pull/273), reporting and settings, from a 1-method stub
to all 6) — and only with all of them green against both tiers was the proof real. Two deletion
orders were load-bearing and were respected: the
`Kysely*Store` SQL guards are the semantic reference for every Phase-B adapter, so **ADR-0019
snapshots them in prose** before D3b; and the race files were re-pointed at `store-emdash` and
green before their `store-postgres` originals were deleted.

**The Postgres CI container stays.** The race gate is `store-emdash` over real Postgres. Deleting
`store-postgres` did not delete the integration job — `better-sqlite3` verifies the SQL, not the
race.

The in-process replacements live in `packages/plugin/src/admin/`: `InProcessAdminOrdersClient`,
`InProcessAdminProductsClient`, `InProcessAdminRulesClient`.

### Verified absent

Checked against the branch this note was written on:

- `packages/service` and `packages/store-postgres` — both gone. `packages/` now holds
  `admin-presentation`, `admin-react`, `domain`, `payments-stripe`, `payments-x402`, `plugin`,
  `store-emdash`.
- `HttpCommerceClient` — the **class definition** is gone; the only occurrence in live source is
  a comment in `packages/plugin/test/make-commerce-client.test.ts` recording that D3a retired it.
  **But stale live-doc references remain**, and they are an open follow-up, not this increment's
  job to fix: `CLAUDE.md` still describes running the client-side contract suite against
  `HttpCommerceClient` over a live test server as the HTTP-task verification path (line 95), still
  says two tiers "need a backing service" (line 52), and still says the plugin "reaches the service
  **only** via `ctx.http` + `allowedHosts`" (line 37); `packages/plugin/README.md:15` still lists
  `HttpCommerceClient` as a current plugin export ("the commerce service over `ctx.http`.
  Transitional."); and `packages/plugin/test/contracts/README.md:5` still refers to it in the
  present tense. The other hits in the tree —
  `.changeset/delete-service-and-store-postgres.md`, `adr/0002`, `adr/0007` and `plans/archive/*` —
  are legitimately historical and should stay.
- `__OTTA_COMMERCE_MODE__` — the only occurrence is `sites/staging/test/site-config.test.ts`, which
  now **asserts its absence**.

---

## 5. What INC-D6 had to reconcile

**Nothing. That is the finding, and it is the good one.**

INC-D6 ran on 2026-09-20 against `emdash@0.38.0`, published 2026-09-15, the first release cut after
#2980 merged upstream (`570333ac`, 2026-09-14). The swap was:
`emdash` and `@emdash-cms/cloudflare` `0.37.0` → **`0.38.0`**, `@emdash-cms/admin` → **`0.38.0`**,
`@emdash-cms/registry-client` → **`0.6.0`**.

### R13 did not materialize

The released `0.38.0` numbers the conditional-write migration **`077_plugin_storage_revisions`** —
the same name the vendored merge renumbered it to. Stronger than that: the released build's
`src/database/migrations/runner.ts` is **byte-identical** to the vendored build's (519
lines, `diff` silent), `runner.ts`'s migration list is identical, and both builds carry
**76** migrations in the same order (`001`–`009`, then `011`–`077`; there is no `010` in either),
with `077_plugin_storage_revisions` last in `MIGRATION_NAMES` in both.

So the fast-path hazard below has no way to fire on this swap: a database migrated by the vendored
build holds exactly the rows the released runner expects, by name. **No staging D1 rename was
needed and none was performed** — no `wrangler d1 execute`, no deploy, nothing written. The read-only
procedure, recorded because the next host bump may genuinely need it: the migrations table is
`_emdash_migrations` (with `_emdash_migrations_lock`), the staging binding is `DB`, the real database
name lives in the gitignored `sites/staging/wrangler.local.jsonc`, and the check is
`wrangler d1 execute <name> --remote --command "SELECT name FROM _emdash_migrations ORDER BY name"`,
compared against the new build's `MIGRATION_NAMES` **by name, never by count**.

### The overrides went away entirely rather than moving to the release

All four `file:` overrides in `pnpm-workspace.yaml` were **deleted, not repointed**, because every
reason they existed is gone at `0.38.0`:

- `@emdash-cms/admin@0.38.0` **does** export `./portable-text-table`, the subpath whose absence at
  `0.37.0` forced the admin package to be vendored alongside the core.
- `@emdash-cms/registry-client@0.6.0` **does** export `./listing-policy`, likewise.
- The quiet one, `@emdash-cms/cloudflare`, still pins `emdash` **exactly** — but it now pins
  `0.38.0`, which is the version the manifests themselves name, so the exact pin and the manifest
  agree and a single copy resolves with no help. Verified: one `emdash@0.38.0` directory in
  `node_modules/.pnpm`, one `emdash@0.38.0` key in the lockfile.

The one-copy outcome is therefore a *coincidence of agreement* rather than something forced, which
is exactly why `sites/staging/test/host-pin.test.ts` was **kept and updated rather than deleted**. If
a future `@emdash-cms/cloudflare` pins an `emdash` other than the one the manifests name, a second
copy returns and the Worker bridge silently binds to the host **without** the primitives; that test
is what makes it loud, and the remedy is to reintroduce an exact `emdash` override.

`minimumReleaseAgeExclude` grew rather than shrank: the four packages used to be absent from it
because `file:` tarballs bypass the release-age check entirely. They resolve from the registry
again, so the whole 0.38 train is listed now.

### Results on the released build

Full battery green, run from the worktree root on the released install:

| Gate | Result |
|---|---|
| `pnpm lint` (incl. the domain-purity dep check) | clean, 1361 modules / 2979 dependencies cruised |
| `pnpm typecheck` | clean |
| `pnpm -r build` | all 9 projects, staging Astro/Worker build included |
| `pnpm test` | **224 files passed**, 17 skipped; 4348 passed, 820 skipped, 14 todo |
| `pnpm test:pg` (Postgres, `127.0.0.1:55432`) | **60 files passed**; 1551 passed, 7 skipped |
| `pnpm test:d1` — **T3, the production dialect** | **14 files passed**; **525 passed, 0 skipped** |
| `pnpm test:e2e` | 13 passed, 21 skipped (the browser-driven specs, which gate on a running site) |

### One pre-existing failure INC-D6 uncovered and fixed

`pnpm test:e2e` was **already red on the integration branch before this increment touched
anything** — `sites/staging/e2e/harness.spec.ts`'s ADR-0006 additive gate, which asserts the set of
skip-shaped constructs in the sandbox suites **exactly**. It had drifted in both directions at once:

- Its `ALLOWED_SKIPS` still permitted a `describe.skipIf` in `account-routes.sandbox.test.ts` and
  `download-route.sandbox.test.ts`. The mode-collapse retrofit (`6657292`) had moved both suites
  onto the plugin's own document store, so neither is Postgres-conditional any more — a
  strengthening the gate did not know about.
- It did **not** permit the 13 `test.todo` cases in `storefront-checkout.sandbox.test.ts` or the one
  in `reports-widget.sandbox.test.ts`, all of them deliberately parked (rather than deleted or
  inverted) when the HTTP transport was deleted, each naming its blocking work in its own title.

Both were corrected, and the gate's matcher was tightened to require a trailing `(` so that *prose
about* a parked case — these suites explain themselves at length — no longer counts as a skip. The
gate is stricter after the fix than before it, and the parked-case count is now a number a reviewer
can argue with. That the branch's e2e had been red for several increments without anyone noticing is
worth recording on its own.

---

## 6. Vendoring detail — the record `vendor/README.md` used to hold

`vendor/` and `scripts/vendor-emdash.sh` were **deleted at INC-D6**. This section is what
`vendor/README.md` said, folded in so nothing is lost with the directory. §3 above is the short
version of the same story; this is the detail behind it, with the temporary "how to rebuild the
tarballs" framing replaced by what the release swap actually settled.

Recoverable from git if ever needed: the tarballs, the recorded diff and the build script are all at
`vendor/` and `scripts/vendor-emdash.sh` in the history of `feat/in-process-commerce` (INC-A0 through
INC-D5), e.g. `git show <pre-D6-sha>:vendor/README.md`.

### What was in the build

| | |
|---|---|
| Base | upstream `main` at `ea2ccd548f7aba9883bc1c9d0cf3c6f642c10a62` (package version `0.37.0`; already carried #2169's `updateIf`) |
| Merged onto it | #2980, the revision-based conditional writes, head `c4b441b05221d936e62a28e2c33214912a7a231a` |
| Merge commit | `39ff8569c914853fa7fde1720632caa6ba4ac91c` |
| Branch head the tarballs were built from | `2dc708318d358631ab0620aded3d2afc0bac6de9`, on `otta/emdash-cas` — the merge plus one post-merge fix-up |
| Migration number used | `077_plugin_storage_revisions` — **and this is the number upstream shipped**, see §5 |
| Tarball version | `0.37.1-otta.1` — the base version's patch bumped and suffixed, so it could never be mistaken for a published release |

The tarballs were a build of upstream's own code, not a fork of it: the merge branch carried the
merge, its conflict resolutions and one fix-up, nothing else. It was pushed to Otta's own fork and
never force-pushed, because it was what the tarballs were built from. Nothing was proposed upstream.
pnpm recorded a sha512 integrity hash per tarball, so a clean `--frozen-lockfile` reinstall
reproduced them, CI included.

### The four tarballs, and why each was required

| Package | Size | Why it was vendored |
|---|---|---|
| `emdash` | 3.9 MB | the primitives themselves |
| `@emdash-cms/admin` | 5.0 MB | **required, not optional.** The core build imports `@emdash-cms/admin/portable-text-table`, and the published `0.37.0` admin did not export that subpath at all — its exports map had only `.`, `./styles.css`, `./locales`, `./locales/*` and `./slugify`. Installing the stock admin beside the vendored core made the core fail to resolve. |
| `@emdash-cms/cloudflare` | 245 KB | the Worker bridge, which had to be the copy that knew the conditional-write operations |
| `@emdash-cms/registry-client` | 129 KB | **same reason as the admin.** The core imports `isProvenFirstRelease` from `listing-policy`, which the published `0.5.0` — the exact version the core asked for — did not export. Without it, importing the root `emdash` entry threw `SyntaxError: … does not provide an export named 'isProvenFirstRelease'`. |

Every other sibling (`@emdash-cms/auth`, `blocks`, `gutenberg-to-portable-text`, `plugin-types`,
`registry-lexicons`, `registry-moderation`, `registry-verification`) matched its published release
and resolved from the registry normally.

**The generalisable lesson, worth keeping past the vendoring:** the host monorepo's workspace
packages can carry source newer than the release their `package.json` version names, and the core
build links against the workspace copy. Any sibling whose unreleased source the core reaches has to
be vendored alongside it. Importing the root `emdash` entry is the cheap way to find them — a missing
one surfaces as an unresolved named import at module-instantiation time, not at install time. Both
gaps closed at `0.38.0` / `0.6.0`, which is why the overrides could be dropped outright.

### Why the overrides were load-bearing

Two failed loudly, one quietly. The loud pair were `emdash` and `@emdash-cms/admin`: the tarballs
cross-pinned each other at `0.37.1-otta.1` / `0.5.1-otta.1`, versions that do not exist on the
registry, so dropping either left a specifier nothing could satisfy and the install stopped. The
quiet one was `@emdash-cms/cloudflare`: the published `0.37.0` depended on an **exact** `emdash`
version the registry *could* satisfy, so without its override a second, stock `emdash` landed in the
store and the Worker bridge bound to the copy **without** the primitives — no install error, no type
error, just missing methods at runtime. That is the failure mode the one-copy assertion exists for,
and `sites/staging/test/host-pin.test.ts` still asserts it.

The overrides had to live in `pnpm-workspace.yaml`: **pnpm 11 ignores `pnpm.overrides` in
`package.json` without warning.** The pins had to never float — no `^`, no `~`: a stray `emdash@1.0.0`
exists on npm and is **not** the latest release of this host. Package manifests kept plain `"0.37.0"`
specifiers throughout, which is what made INC-D6 an override edit plus a three-manifest version bump
rather than a sweep.

### The conflict resolutions in the merge

Both sides added methods to the same storage surfaces, so almost every conflict was "keep both".
`vendor/otta-emdash-cas.diff` was the machine-readable record — `git diff <base> <branch head> --
packages/` — so `git apply --check` against a future base answered "do the recorded resolutions still
apply?" without a clone.

1. **The migration-number collision — the load-bearing one.** #2980 added
   `076_plugin_storage_revisions`; the base already ended at `076_collection_nav_group`. Renumbered
   to **`077_plugin_storage_revisions`** — the file, its three `.ts` importers, and the runner's
   import alias and map key. (Upstream shipped the same number. See §5.)
2. **Type re-exports** (core's root and plugin entries, and the plugin-storage repository): keep both
   sides' exported type names.
3. **The sandbox bridge protocol, host implementation and in-sandbox wrapper**, for both the
   Cloudflare and workerd runtimes: keep both sides' operations.
4. **The migrations integration test**: take #2980's form, which slices the runner's exported
   migration-name list instead of restating the tail by hand, so it needs no edit when a migration is
   added.
5. **The workerd integration test**: keep both sides' cases as **two separate tests**. A textual
   "keep both" interleaves them into one broken block, because both sides add a case in the same
   place with the same surrounding shape.
6. **The base's D1 `updateIf` test** builds its storage table by hand and needed the `revision`
   column the merged repository writes on every write — one added column, matching what #2980 did to
   its own fixtures.
7. **The storage documentation page**: keep both sections.
8. **One post-merge fix-up, not a conflict resolution.** The keep-both on the Cloudflare sandbox
   bridge's `import type … from "emdash"` list left a `NumericDelta` import neither parent uses, and
   the host lints with `oxlint --type-aware --deny-warnings`, so the merge commit itself did not lint
   even though both of its parents did. The fix was the one commit on top of the merge — which is why
   the build recorded a **branch head** as well as a merge commit.

### Node and wrangler

`engines.node: ">=22.16"` is the host's own floor, and the rule the repo settled on is: the root
manifest declares it, and so does every manifest that resolves the host (`sites/staging`,
`packages/admin-react`); no other package restates it, and CI pins the major line only
(`node-version: "22"`), which satisfies the floor without narrowing to one minor. The `wrangler`
catalog entry moved `^4.68` → `^4.99` because `@emdash-cms/cloudflare` declares
`peerDependencies.wrangler >= 4.99.0` — still true at `0.38.0`, so the catalog entry stays.

### Build evidence, as recorded at the time

On the vendored base: the host's own storage, conditional-write, no-oversell and migration suites
passed on SQLite and Postgres, its Worker-runtime sandbox suites passed, and a throwaway consumer
confirmed the migrations applied with `077_plugin_storage_revisions` as the tail and that all four
primitives behaved as documented, stale-revision refusals included.

One upstream test is worth naming because it is **sometimes red and should be discounted**:
`@emdash-cms/cloudflare`'s `tests/db/d1-migration-target.test.ts` — "uses project-local Wrangler and
preserves account inheritance for a named environment" — spawns a real `wrangler` process and times
out against the suite's 5s default on a loaded machine. It is upstream's test, it does not touch the
primitives, and nothing Otta ships depends on it.
