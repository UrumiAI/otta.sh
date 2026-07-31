# 0014. A second descriptor `otta-console` (native format) may serve React admin screens

- Status: accepted
- Date: 2026-07-31
- Amends: **ADR-0006 Decision 2 only** — the trusted-only-API fence, insofar as it forbids
  React admin components. ADR-0006 **Decision 1 is reaffirmed unchanged**: the workerd
  sandbox suite remains the contract gate for `@otta-sh/plugin`.
- Relates to: ADR-0003 (route-based storefront — untouched), ADR-0013 (the fields the
  migrated Pricing screen may not offer)

## Context

ADR-0006 Decision 2 reads, verbatim:

> **Trusted-only APIs remain forbidden** in `@otta-sh/plugin`: no React admin components, no
> `page:fragments`, no `options`-configured native format, no direct DB/storage access —
> nothing that could not also run sandboxed. ADR-0003's route-based storefront shape stays.

That sentence forbids the Orders and Pricing migrations outright, so it has to be amended
deliberately or the migrations must not happen. This record amends it, and says what it cost.

### Why the pressure exists: Block Kit is frozen, and the fork is not deployed

Block Kit is not evolving. `packages/blocks/src/types.ts` is **byte-identical** between the
local checkout and upstream `origin/main`; across 530 commits and 23 releases
(0.16.0 → 0.31.1) the entire package changed by four files — CHANGELOG, version bump, and one
dead type import — and all 23 changelog entries are empty version headers. Greps over
upstream blocks source for `row_action`, `onRowClick`, `href`, `align`, `level`, `"link"` and
`width` return **zero hits each**. So the vocabulary the admin screens want is absent at every
version through 0.31.1, and no upgrade produces it.

The remaining option under Decision 2 was a fork. **The fork is out of scope.** Otta resolves
stock `emdash@0.31.1` and `@emdash-cms/cloudflare@0.31.1` from the public npm registry, pinned
**exact** in `sites/staging/package.json` and integrity-hashed in the lockfile: no `link:`, no
`file:`, no git ref, no `overrides`, no `resolutions`, no `patchedDependencies`, no vendored
copy. That stays true. The row-action work that exists on fork branches is **not** in the
installed `@emdash-cms/blocks@0.31.1`, so it does not affect the running admin at all; the
plugin can emit any JSON it likes, but the renderer comes from npm.

Staying on Block Kit for every screen therefore means a standing obligation to land changes
upstream (unbounded latency) or to own a CMS fork — a cost that grows with every gap. That is
the trade this amendment prices, not a preference for React.

### The technical gate is `format`, not placement

Two orthogonal axes. **Placement**: `plugins: []` is trusted in-process, `sandboxed: []` is an
isolate. **Format**: `format: "standard"` (default-exports `{hooks, routes}`, runs in either
array) versus `format: "native"` (exports `createPlugin()`, trusted only). React admin UI is
gated on *format*, by an unconditional build-time throw in
`packages/core/src/astro/integration/index.ts:334-351`:

> `Plugin "<id>" is standard format but declares adminEntry. Standard plugins use Block Kit
> for admin UI, not React components. Remove adminEntry or change format to "native".`

Otta already runs trusted, and that alone unlocks nothing — **React ⇒ trusted, but trusted
⇏ React.** The throw is verbatim identical at 0.15.0 and 0.31.1. Critically, it is evaluated
**per descriptor**: the loop tests only the entries where `format === "standard"`.

### Nothing mechanically enforced Decision 2's React clause

Worth recording, because it changes what this amendment is doing. `.dependency-cruiser.cjs`'s
`plugin-is-sandbox-clean` rule forbids DB, Node and HTTP-client imports — **not `react`** — and
`sites/staging/test/site-config.test.ts` pins `format` and `fieldWidgets` but asserts nothing
about `adminEntry` or `componentsEntry`. The real gates were EmDash's build-time throw and the
18 sandbox suites. So this amendment does not remove a guard; it replaces prose with a boundary
that is then **mechanically pinned** (see "Preconditions" below).

### The spike: built and run, not reasoned about

A two-descriptor hybrid was built against the real staging config on 2026-07-31 and every
prediction was checked rather than argued:

- **The build works, and the negative control fires.** `astro build` succeeded with both
  descriptors registered. `emdash@0.31.1`'s astro integration throws at build time for any
  descriptor with `format: "standard"` that declares `adminEntry` — that check ships in the
  installed package, on disk in `node_modules/emdash`, not just upstream source — so the gate
  is real, live at 0.31.1, and evaluated per descriptor.
- **The one unverified thing came back yes.** `POST /_emdash/api/plugins/otta/admin` →
  **HTTP 200**, served to a page owned by `otta-console`; envelope `[success, data]`. It works
  structurally, not incidentally: the route handler
  authorises on the session user's `plugins:manage` permission, the token scope, and the
  `X-EmDash-Request` CSRF header. **Nothing in the request identifies the calling plugin** —
  the dispatcher has no concept of one.
- **Descriptor isolation held exactly.** The runtime manifest came back `otta` →
  `adminMode: "blocks"` with all seven pages, `otta-console` → `adminMode: "react"` with one.
  All seven Block Kit pages still returned real blocks.
- **The contract gate survived untouched.** 18/18 sandbox files and 409/409 tests green, with
  `git diff main -- packages/plugin` **empty** — green by construction, because nothing in the
  plugin package moved. Exactly one existing assertion broke:
  `sites/staging/test/site-config.test.ts`, which pins `plugins: []` to a single entry — the
  test doing precisely its job.
- **Deployment cost, measured rather than assumed.** A production build sized by
  `wrangler deploy --dry-run` grows the Cloudflare Worker script by **+0.19 KiB gzipped**
  (194 bytes) — 0.008% of the paid-plan budget — with **bindings, compatibility flags and
  module count byte-for-byte identical**. The React page lands in **client assets**, not
  `dist/server`; the Worker gains only a small region holding the descriptor and
  `createPlugin()`.

The cheaper-looking fallback is worse than the risk it insures against: `ctx.kv` is namespaced
per plugin id, so a purpose-built route on `otta-console` would open onto an empty settings
namespace and would need the service token duplicated into a second plugin's settings, plus its
own `network:request` capability and its own `allowedHosts`. Cross-plugin fetch is the clean
path here, not the compromise.

## Decision

**A SECOND EmDash descriptor, id `otta-console`, `format: "native"`, may render React admin
pages alongside the existing `otta` Block Kit descriptor in the same `plugins: []` array.**
Concretely, and exhaustively:

1. **`@otta-sh/plugin` is unchanged, and Decision 2 continues to bind it in full.** It stays
   `format: "standard"`, sandbox-clean, with **zero EmDash dependency** — not in
   `dependencies`, not in `devDependencies` — and `packages/plugin/src/types.ts` stays a
   hand-written mirror of EmDash's plugin and Block Kit types. No `react`, no `emdash`, no
   `@emdash-cms/*` import enters that package under any circumstance. Its best structural
   property (a pinned-exact upgrade cannot break it by construction) is not being spent.
2. **The React code lives in a NEW package** (`@otta-sh/admin-react`, per the migration plan),
   never in `@otta-sh/plugin` and never in `sites/staging` application code.
3. **`otta-console` declares zero capabilities and zero `allowedHosts`**, owns no hooks and no
   routes, and reaches the commerce service **only** by calling the **existing authenticated
   `otta` admin routes** from the browser. It gets no new data path.
4. **Registration is unchanged in kind**: both descriptors in `plugins: []`, still **no
   `sandboxed:` and no `sandboxRunner:`** — the Worker-Loader / Workers-Paid cost pivot ADR-0006
   exists to avoid stays avoided.
5. **The dependency floor stays stock and pinned exact**: `emdash@0.31.1` and
   `@emdash-cms/cloudflare@0.31.1` from public npm. No fork, no fork build, no
   `patchedDependencies`, no `overrides`, no vendored copy. This amendment is not a licence to
   fork; it is what makes the fork unnecessary.
6. **Migration scope is fixed**: **Orders first, Pricing & inventory second.** **Tax, Shipping
   and Settings stay Block Kit permanently.** Reports and Coupons get plugin-side fixes and are
   **re-evaluated only after the Pricing & inventory migration lands** — neither begins without
   a ruling.
7. **Two descriptors is a requirement, not a style choice.** Sidebar visibility is derived **per
   plugin id** — one `adminMode` per plugin, `"react"` the moment `admin.entry` exists, after
   which the sidebar hides that plugin's declared pages lacking a React component. So a single
   React page added under id `otta` would make **the other six Block Kit pages vanish from the
   sidebar** while still rendering at their URLs. The second id avoids this **by construction**;
   that is the whole reason for it.

### ADR-0006 Decision 1 is REAFFIRMED, not weakened

Stated separately so it cannot be read as collateral to the above:

- The **18 `packages/plugin/test/*.sandbox.test.ts` suites remain the contract gate.** None is
  deleted, skipped, weakened or made conditional by this amendment or by any migration
  increment under it. A change to `@otta-sh/plugin` that only works trusted is still broken and
  still must not merge.
- The sandbox suites are **browser-blind** — they cannot cover React, which is why Playwright is
  added as the gate **for React screens only**. That is **additive**. It replaces nothing.
- **The Block Kit screens stay in the tree and stay green until a migration increment replaces
  each one**, screen by screen. Removing a Block Kit screen or its suite is a separate decision
  and is not authorised here.
- ADR-0006's other Decision-2 prohibitions stand unamended: no `page:fragments`, no
  `options`-configured native format, no direct DB/storage access, and ADR-0003's route-based
  storefront shape is untouched. This amendment widens the fence by exactly one thing — React
  admin pages, on a separate descriptor, in a separate package.

### Preconditions before any React ships

Because prose enforces nothing on its own — as established above, `plugin-is-sandbox-clean`
forbids DB, Node and HTTP-client imports but not `react`, and `site-config.test.ts` asserted
nothing about `adminEntry` or `componentsEntry` — the boundary above is pinned mechanically
**before** the first React screen, not after:

- `site-config.test.ts` pins **both** descriptors: `otta` remains `format: "standard"` with **no
  `adminEntry`** and **no `componentsEntry`**; `otta-console` is `id === "otta-console"`,
  `format === "native"`, with `capabilities` and `allowedHosts` each **deep-equal to `[]`** —
  hard pins, where a non-empty value fails the suite.
- A new dependency-cruiser rule quarantines `react`, `emdash*` and any component library to the
  new package, keeping them out of `packages/plugin/**`. `plugin-is-sandbox-clean` stays exactly
  as it is.
- A Playwright harness with at least one smoke spec per migrated screen.

## Consequences

### What becomes easier

- On Orders specifically: row click; no server round-trip per interaction; the
  `block_id`-as-React-key remount hazard gone (and with it the "cannot close a group"
  limitation); carrier encoding gone; row virtualization; and the per-cell copy button the UUID
  display rule wants. Client-side filter and sort measured at zero network calls, with the
  filter surviving the sort.
- The migrated screens **stop depending on unfiled fork branches**, which is the durable win:
  no standing upstream obligation and no CMS fork to own.
- Deployment is a non-issue at the Worker layer: **+0.19 KiB gzipped** (194 bytes), bindings,
  compatibility flags and module count unchanged.

### What becomes harder, and what we accept

- **It inverts the plugin's best property — but only for the new package, and by exactly two
  peers.** Measured on the spike, the React surface needed **`react` and `emdash`** and nothing
  else (`PluginAdminExports`, `definePlugin`, and `apiFetch` from `emdash/plugin-utils`).
  `@cloudflare/kumo` and `@phosphor-icons/react` were **unresolvable and never needed** —
  `@emdash-cms/plugin-forms` uses them *by choice*, and the spike's coloured badges came from
  plain inline styles. Kumo sits transitively in the pnpm store, so it *could* be adopted; that
  would be a **deliberate new coupling to an unpinned component library, not a requirement**,
  and it is not taken here. What is genuinely traded is a JSON protocol **verified frozen across
  0.15.0 → 0.31.1** for a component library with no such guarantee. A separate package contains
  that exposure; it does not eliminate it.
- **`ctx.http` + `allowedHosts` stops meaning anything for that surface.** The React page runs in
  the browser and calls admin routes directly; no hostname allowlist governs it. The compensating
  controls are the empty capability set, the empty `allowedHosts`, the deep-equal test pins above,
  and the fact that the admin routes it calls are the same authenticated ones the Block Kit
  screens already use.
- **`format: "native"` makes full runtime access the declared contract for that descriptor**,
  rather than an acknowledged exception — even though the descriptor asks for nothing.
- **The native descriptor is marketplace-ineligible** (the bundler hard-exits on `adminEntry`).
  Smaller than it looks: Otta already requires a hand-edited astro config, and
  marketplace-installed plugins cannot surface `fieldWidgets`/`portableTextBlocks` anyway.
- **The 18 sandbox suites cannot cover React**, and ADR-0006 calls those suites the only thing
  keeping "runs trusted" honest. That statement remains true **of `@otta-sh/plugin`**, whose
  coverage does not shrink. The React surface is simply outside their reach, so it carries its
  own gate. Two gates now, of different kinds — a real increase in what has to stay green.
- **Sunk Block Kit investment on every migrated screen**: tests, spec text, and a scaffold whose
  entire purpose is compensating for Block Kit statelessness.
- **The admin client chunk grows with each migration.** `PluginRegistry.js` is already 7.94 MB
  raw / 1.90 MB gzipped **before** any migration, and every migrated screen adds to it. That is
  an admin page-load concern, not a platform-limits concern, and it is the real marginal cost —
  not the Worker.
- **Two rendering idioms in one console, permanently.** Tax, Shipping and Settings never migrate,
  so contributors will always meet both. Money still goes through `formatMoney`; the React
  surface does not get its own money formatting, and ADR-0013's read-only Title rule binds the
  migrated Pricing screen exactly as it binds the Block Kit one.

### What would reopen this decision

- Any `emdash` / `@emdash-cms/*` / `react` dependency appearing in `@otta-sh/plugin`.
- Any of the 18 sandbox suites being deleted, skipped or weakened (this already reopens
  ADR-0006 on its own terms).
- `otta-console` acquiring a capability, an `allowedHost`, a route, or a hook.
- Any third-party plugin entering `plugins: []` — ADR-0006's original consequence stands
  unchanged: a multi-tenant or marketplace deployment must not inherit any of this.
- A proposal to migrate Tax, Shipping or Settings, which this record forbids.
