# 0014. A second descriptor `otta-console` (native format) may serve React admin screens

- Status: accepted
- Date: 2026-07-31
- Partially superseded: 2026-08-01 — **the "Block Kit screens stay in the tree and stay green"
  clause only** (the third bullet of "ADR-0006 Decision 1 is REAFFIRMED, not weakened" below),
  and only as to the **Orders** and **Pricing & inventory** screens, by
  [ADR-0015](./0015-retire-duplicated-block-kit-screens.md). Every other clause of this record
  stands, Decision 6 included.
- Amends: **ADR-0006 Decision 2 only** — the trusted-only-API fence, insofar as it forbids
  React admin components. ADR-0006 **Decision 1 is reaffirmed unchanged**: the workerd
  sandbox suite remains the contract gate for `@otta-sh/plugin`.
- Amended: 2026-09-13 — **Decision 5 only** (the stock, pinned-exact dependency floor), and only
  for the duration of the vendored host build carrying the conditional-write storage primitives,
  by [ADR-0018](./0018-plugin-owns-commerce-truth-in-process.md). Decision 5's intent — that a
  host upgrade cannot quietly break the plugin — is unchanged, and Decision 1's zero-EmDash-
  dependency property for `@otta-sh/plugin` is untouched.
- Amended: 2026-09-30 — **Decision 6 only**, by adding one screen: the storefront **Themes** screen
  is a React page on `otta-console`. See "Amendment 2026-09-30" at the end. Tax, Shipping and
  Settings still never migrate; the Settings "Store theme" radio stays as the Block Kit fallback.
- Amended: 2026-10-01 — **Decision 6 only**: Pricing & inventory leaves the sidebar. Its fields
  move into **Pricing, Inventory and Shipping & tax cards** in the product editor's main column and
  **content-list columns** on the `products` collection,
  served by `otta-console`, and the `/products` page is retired. See "Amendment 2026-10-01" at the
  end.
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

## Correction 2026-08-01 — Decision 7's page count was off by one

The Decision above is unchanged in substance and is deliberately left as written. One **number**
in Decision 7 is wrong, and it is corrected here rather than edited in place, because it is the
count the whole two-descriptor argument turns on.

Decision 7 reads: *"a single React page added under id `otta` would make **the other six Block Kit
pages vanish from the sidebar**"*. **It is seven, not six.** The `otta` descriptor declares
**seven** admin pages — Reports, Settings, Orders, Products, Tax, Shipping, Coupons
(`sites/staging/src/otta-plugin-descriptor.ts:61-69`) — and the spike in Context above says so
twice ("all seven pages", "all seven Block Kit pages still returned real blocks"). A React page
**added** under `otta` is an eighth entry; the seven that already exist are the ones lacking a
React component, so all seven vanish. "Six" would be right only if one of the existing pages were
*converted*, which is not what the sentence describes.

**Nothing else moves.** The decision is strengthened rather than weakened — the cost of the
single-descriptor alternative is one page higher than recorded — and no other clause depends on
the figure. Every other count in this record is correct as written, including
[`docs/admin/ADMIN-CONSOLE.md`](../docs/admin/ADMIN-CONSOLE.md)'s "seven admin screens", which had
the same off-by-one in its own earlier revisions and was fixed there first.

## Amendment 2026-09-30 — the storefront Themes screen is a React page

**What changes.** Decision 6 fixed the console's scope; a screen outside it needs a ruling. This is
that ruling, for one screen: `otta-console` gains `/themes`
(`THEMES_PAGE`), a WordPress-style theme picker for [ADR-0024](./0024-storefront-themes-are-runtime-selected-full-templates.md)'s
storefront themes — a grid of screenshot cards with the active theme first under a solid accent
bar, an **Activate** button on every other card, and a **Live preview** that frames the real
storefront in that theme in a full-screen overlay (desktop / tablet / phone widths, Esc to close,
"Open in new tab"). The maintainer asked for it in these terms and chose React over Block Kit for it.
The work is increment **INC-26**.

**Why it cannot be Block Kit.** Not preference — the screen needs things Block Kit does not have:

- **No image card.** Block Kit's `image` block is a standalone element; there is no card that
  pairs a picture with a footer and actions, and no control over aspect ratio or crop.
- **No hover or focus state.** The "Live preview" affordance appears over the picture on hover and
  on keyboard focus; Block Kit renders no pointer or focus styling of its own.
- **No link.** "View store" and "Open in new tab" are navigations; Block Kit actions are only
  round trips to the plugin route.
- **No frame.** The live preview is an `<iframe>` of the storefront; Block Kit has no embed.
- **No re-ordering or client-side state.** The grid re-orders when a theme is activated; a Block
  Kit screen can only re-render the whole tree from the server.

**What does not change.**

- **One data path.** The screen reads `themes.list` and writes `themes:activate` through the `otta`
  admin route with the existing `otta_console_read` / `otta_console_act` interaction types
  (`packages/plugin/src/admin/themes-console-route.ts`). `otta-console` still holds zero
  capabilities, zero `allowedHosts`, no route, no hook and no storage (Decision 3).
- **One write path.** Activate calls the same `saveStoreTheme` the Settings "Store theme" radio
  calls (`store-theme-kv.ts`): an id the site offers, into kv `settings:storeTheme`, or nothing.
- **The Block Kit fallback stays.** The Settings "Store theme" radio is not removed. Settings stays
  Block Kit permanently, as Decision 6 says; this amendment adds a screen and migrates none.
- **No component library.** The screen reads the admin's Kumo CSS custom properties
  (`--color-kumo-brand`, `--color-kumo-base`, …) with theme-neutral fallbacks, so it is native in
  light and dark mode. That is a dependency on the stylesheet the page already renders inside, not
  on `@cloudflare/kumo`, which stays unadopted.

**The preview is a site feature, not an admin one.** The overlay frames `/?preview_theme=<id>`; the
site honours it for a signed-in, enabled user with role ≥ ADMIN (50) only, keeps it across in-frame
links with a session cookie, marks every previewed response `Cache-Control: private, no-store`, and
shows a "Previewing … — not live · Exit preview" pill. Recorded in ADR-0024's amendment of the same
date.

**The frame is same-origin and unsandboxed, on purpose.** The overlay's `<iframe>` carries no
`sandbox`: the dialog listens for Esc on the frame's window (key events inside the frame never reach
the dialog), and the frame must send the admin's session cookie for the site to honour the preview.
That is acceptable because what it frames is this store's own first-party storefront code, which
already runs under [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md)'s
client-JS fence — not third-party content.

**A live preview is the real store.** It renders the real catalogue, cart and checkout in another
theme; adding to cart or checking out inside it creates real holds and real orders. And the preview
cookie is browser-session-wide, not frame-wide: while a preview is on, the admin's other storefront
tabs render in the previewed theme too. Closing the overlay ends the preview everywhere in that
browser — including a tab opened with "Open in new tab".

**Reopens this amendment:** a second React screen justified by this one instead of by its own gaps;
the Settings radio being removed; or the Themes screen acquiring a write other than `saveStoreTheme`.

## Amendment 2026-10-01 — Pricing & inventory moves into the product editor

**What changes.** A shop owner edits a product in two places today: its title, description and
images under **Content › Products**, and its price and stock in **Pricing & inventory**, a page at
the bottom of the sidebar under "Plugins". Merchants read that as two different products. EmDash
cannot merge two sidebar items or move a plugin page into the Content group (emdash-cms/emdash
#1023 is open), but a native plugin can contribute surfaces that sit **inside the collection's own
screens**:

- a **field editor** (`fields` on the admin module), which EmDash draws in the editor's MAIN column
  for any field whose `widget` names it; and
- **content-list columns** (`contentListColumns`), read-only cells in the collection's list.

So the products collection gains one field, `pricing` (`json`, `widget: "otta-console:pricing"`),
placed after Images, and `otta-console`'s `fields.pricing` draws **Pricing**, **Inventory** and
**Shipping & tax** cards there — the layout the large commerce admins use. `otta-console` also
exports **Price** / **Stock** columns. The `/products` page ("Pricing & inventory") is **retired**:
it leaves `admin.pages`, the sidebar and the console-screens registry.

A content editor panel (`contentEditorPanels`) was built first and rejected for placement: EmDash
puts plugin panels after all of its own settings sections, with no default-position option, so the
merchant had to scroll the side column to find the price.

**The `pricing` field holds no data.** It only marks where the cards go: the editor never calls the
field's `onChange`, no seeded entry carries a value, and every value the cards show or change lives
in the commerce store, as before (PR 1b's rule, kept). `seed.test.ts` pins the field's role, and
the binding is the only plugin widget bound on the collection. New stores get the field from the
seed. EmDash 0.38's Content Types screen cannot bind a widget, so a store created before this change
adds it with `sites/staging/scripts/add-pricing-field.ts`, through the schema API (which accepts
`widget`; a later edit of the field in that screen keeps it). **The fallback is a hazard to name:**
when the widget is missing or `otta-console`'s admin module fails to load, EmDash draws its raw JSON
editor for the field, which would store whatever is typed into the CMS. DEPLOYMENT.md says to leave
it empty and re-run the script. Decision 6's
scope is unchanged in kind — the same fields, edited by the same writes — and only the place they
are edited moves.

**What does not change.**

- **One data path (Decision 3).** Both surfaces call the existing `otta` admin route with
  `otta_console_read` / `otta_console_act`. The cards read `products.detail`, move stock with
  the retired page's `products:restock` / `products:remove-stock`, and saves through one new
  action id, `products:save`, which runs the same sparse save handler as the page's three split
  saves (same watermark, same content-derived idempotency key) with every field the cards own. A
  field editor is not told when the CMS saves the entry (which moves the commerce watermark), so a
  save re-reads the product first and keeps only the merchant's own edits on top of it. The columns read
  one new resource on that same route, `products.summaries`: the price and on-hand of a bounded
  list of product ids, which is the page of rows the list is showing. It is a read on the existing
  authenticated route, not a new route, capability or host.
- **CMS ownership (ADR-0013).** Title, description, images and publish status stay the CMS's. The
  cards offer no title and no active flag, exactly as the retired page did; the product id is the
  CMS entry id, which the cards read from the editor's address (`…/content/products/<id>`) because
  EmDash gives a field editor the field's value and nothing about the entry.
- **Who sees them.** The `otta` admin route requires `plugins:manage` (ADMIN), and remains the
  authorization boundary. The columns declare `minRole: 50`. A field editor has no `minRole`, so a
  user below ADMIN who can edit products sees the cards and gets the route's 403 copy ("ask an
  administrator to grant the plugins:manage permission") — refused, never written.
- **No component library**, as before: inline styles over the admin's Kumo custom properties
  with theme-neutral fallbacks.

**What gets harder.** The cards save separately from the CMS's own Save and Publish, and the
editor's unsaved-changes guard cannot see them. They warn on unload and ask before an in-app link
leaves them with unsaved edits; the browser's Back button is not covered. A new product has no id yet, so it is saved once before it can be priced; the
cards say so. The cards depend on the editor's address shape and on the `pricing` field existing on
the collection; without the field there is nowhere to draw them. The columns are read-only, so stock and price are
changed from the product, not from the list. A merchant who wants a dedicated stock-taking table
has none until one is justified on its own.

**Left for a follow-up.** The retired page's React modules (`products-screen.tsx`,
`products-list.tsx`, `product-detail.tsx`) and the three split save ids only they send stay in the
tree, unregistered, because the shared console tests use them as their fixture. Moving those tests
onto Orders and deleting the modules is the next change.

**Reopens this amendment:** the `pricing` field storing a value; a card or column offering a
CMS-owned field; either surface reading or
writing through anything but the `otta` admin route; or the retired page returning beside the cards.

