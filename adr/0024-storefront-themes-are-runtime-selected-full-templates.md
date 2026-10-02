# 0024. Storefront themes are runtime-selected full templates over shared page logic

- Status: accepted
- Date: 2026-09-29
- Refines: [ADR-0003](./0003-storefront-plugin-routes.md) — "the theme owns markup" becomes "the
  **active** theme owns markup". Its route shape, its JSON view models and its rule that storefront
  intelligence stays out of the markup layer are unchanged. Builds on
  [ADR-0006](./0006-trusted-in-process-deployment.md) (the site's origin guard and cookie shim) and
  [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md) (the client-JS fence).
- Amended: 2026-09-30 — an admin **Themes** screen (React, on `otta-console`; ruled in
  [ADR-0014's amendment of the same date](./0014-second-native-descriptor-for-react-admin.md#amendment-2026-09-30--the-storefront-themes-screen-is-a-react-page))
  and an admin-only **live preview** (`?preview_theme=<id>`). See "Amendment 2026-09-30 — the Themes
  screen and the admin-only live preview" at the end.
- Amended: 2026-09-30 (second) — a theme may opt into a fail-soft chrome **bag read**
  (`chrome.cartLines`). See "Amendment 2026-09-30 — the opt-in chrome bag read" at the end.
- Note: 2026-10-01 — five of the six themes (`plinth`, `pressing`, `batch`, `jumble`, `counter`)
  moved out of this repo; only `tempered` ships here. The decision is unchanged. See "Note
  2026-10-01 — five themes moved out of this repo" at the end.
- Amended: 2026-10-02 — **the admin offers no theme choice.** The Themes screen, its live preview
  and the Settings "Store theme" radio are removed; the store renders Tempered. Decision 2 ("the
  merchant picks the theme in the admin") and the 2026-09-30 Themes-screen amendment are retired;
  the rest of the theme system stays. See "Amendment 2026-10-02 — no theme choice in the admin" at
  the end.

## Context

`sites/staging` ships one look, Tempered (`docs/theme/TEMPERED.md`). A merchant who wants a different
storefront today has to fork the site. We want several finished storefronts a merchant can switch
between from the admin, with no rebuild and no redeploy.

A palette swap is not enough. The five new designs differ in layout, not just colour: Plinth has no
dividers and stacks images beside a sticky buy column, Pressing puts a sticky countdown strip under
the page, Batch overlaps a label on the photo, Counter has the only overlay cart. So a theme has to own
per-page markup and layout, not only tokens.

Three facts about the platform shape how that can work:

- **Plugin kv is readable from SSR.** EmDash prefixes a plugin's kv keys with `plugin:<id>:`, and
  exports `getPluginSetting(pluginId, key)`, which reads the options row
  `plugin:<id>:settings:<key>`. A plugin write of `settings:storeTheme` should therefore be readable on
  the site as `getPluginSetting("otta", "storeTheme")`. The infrastructure change proves this with a
  test against the real host before anything relies on it, and that round trip stays pinned by
  `sites/staging/test/theme-resolve.test.ts`.
- **Astro links CSS from the static import graph.** A registry that statically imports every theme's
  `.astro` files would link every theme's `<style>` blocks on every page, whichever theme is active.
- **The page files already carry logic that must not fork**: `isBusyResult` + `markBusy`, 404/503
  status, `safeReturnPath`/`sameSitePath`, the origin guard, and the cart and checkout cookies. Six
  copies of that is six chances to drop a CSRF check.

Options considered: build-time theme selection (a rebuild per switch, which is what we want to
avoid); CSS-only themes over one markup (cannot express the layouts above); and runtime-selected full
templates over shared page logic (this record).

## Decision

**1. A theme is a full template, selected at runtime.** Each theme supplies a `Layout` and a view per
page (home, shop, product, cart, checkout, pay, order, and the account login, verify, orders and order
views), plus its own stylesheets and fonts. A theme lands whole: one change brings every one of its
views. They live in `sites/staging/src/themes/<id>/`. A `registry.ts` maps each `ThemeId` to its
`ThemeModule`. One shared shell, `src/layouts/Storefront.astro`, resolves the active theme and renders
`<theme.Layout chrome={…}><View model={…}/></theme.Layout>`, with `data-theme-id` on `<html>`.

**2. The merchant picks the theme in the admin.** The plugin's Settings page gets a "Store theme"
radio group in the Store group — a radio, not a `select`, because EmDash's select trigger shows the
raw option id rather than its label. It is saved to plugin kv `settings:storeTheme`, and the toast
says it goes live on the next page load. An unknown id is refused and the form re-renders with an
error notice.

**3. The site reads it per request, and failure means Tempered.** `themes/resolve.ts` does one guarded
read (`getPluginSetting` inside `try`/`catch`), memoized on `Astro.locals`, so a request pays for at
most one read however many components ask. An absent value, an unknown id or a failed read all resolve
to `tempered`. A theme setting can never take the storefront down.

**4. A dev-only `?theme=<id>` override** exists for screenshots and e2e. It is honoured only when
`import.meta.env.DEV` is true and is absent from production builds.

**5. The plugin still does not know which themes exist.** It serves JSON view models exactly as
ADR-0003 says and hard-codes no theme id. The site owns `themes/manifest.ts` (pure `[{id, label}]`
data, no `.astro` imports) and hands it to the plugin at build time through a Vite define,
`__OTTA_STORE_THEMES__`, the same pattern as `__OTTA_EMAIL_API_URL__`. The plugin reads it behind a
`typeof` guard and a shape check. On a host that does not define it (the sandbox, other sites), no
theme picker is rendered and `save-theme` is rejected.

**6. Page logic is single-sourced; views are presentation only.** Data loading, busy handling, 404/503,
return-path safety, the origin guard and cookies stay in the page files, and the `.ts` endpoints are
untouched. Pages compute every value a view shows, including BUSY copy, into typed models
(`ChromeModel`, `HomeModel`, `ShopModel`, `ProductModel`, later cart/checkout models) defined in
`themes/contract.ts`. A theme view never reads `Astro.url`, cookies, cart ids or `Astro.response`,
never redirects, and never imports `lib/otta-api`, `origin-guard`, `cart-cookie` or `checkout-cookie`.
A sweep test over `src/themes/**` enforces this. The `busy.test.ts` sweep keeps covering every page.

**7. A missing view falls back to Tempered under the active theme's tokens.** Every theme ships all
of its views (Decision 1); the fallback is a safety rule, not a phase plan. `ThemeModule.views` is
partial: `theme.views.X ?? tempered.views.X`. Today's `--u-*` custom properties become the token
contract every theme's `theme.css` must define, so a view a theme does not supply still renders in
that theme's colours and fonts. The design briefs' `--o-*` names are theme-internal and map onto `--u-*`.

**8. Only the active theme's CSS and fonts reach the page.** Theme `.astro` files contain no `<style>`
blocks and no side-effect CSS imports. Each `Layout` links its own sheets
(`theme.css` plus its views/commerce sheets, each through `import href from "./….css?url"` →
`<link rel="stylesheet" href={href}>`). Every font family is declared once in `astro.config.ts` under
a namespaced variable, `--f-<id>-<role>` (e.g. `--f-tempered-display`, `--f-tempered-body`).
Each `Layout` emits only its own `<Font … preload>`, and its `theme.css` maps those onto the shared
names. Exception for the infrastructure change: Tempered's existing hash-scoped component `<style>`
blocks in `src/components/*` may stay; only its global `:root` tokens move to
`themes/tempered/theme.css`.

**9. Motion policy.** Each theme gets exactly one authored signature moment and no page-wide scroll
reveals. All motion sits inside `@media (prefers-reduced-motion: no-preference)`, and every signature
has a stated reduced-motion form. Where a theme wants page-to-page continuity, it uses cross-document
view transitions (`@view-transition { navigation: auto }`). There is no client router. Any small
per-theme script must be justified and pass ADR-0012's client-JS fence (`checkout-client-js.test.ts`,
widened to cover `src/themes` and `src/forms`).

**10. The theme ids are fixed:**

- `tempered` — the default and the fallback: today's look, hairlines, money in mono, the draining
  hold ribbon.
- `plinth` — minimal gallery for design objects: no dividers, monochrome (ochre only for warnings),
  small type, and a view-transition morph from card to product page.
- `pressing` — record-label drops, dark only: ultramarine with sleeve pink, expanded display type,
  a disc that slides out of its sleeve, and a sticky countdown strip.
- `batch` — specialty roaster: kraft ground, slab labels, roaster green, and a stamp that lands
  on add.
- `jumble` — wooden toys: bright colour fields, casual Recursive type, and the added item hopping
  to the bag.
- `counter` — the general-purpose shop: one swappable brand colour used only for actions, a
  comfortable scale, and the only overlay cart (a drawer).

Adding a seventh theme means a new directory, a manifest entry and a registry entry. It does not need
a new ADR unless it breaks one of the rules above.

## Consequences

- **One extra D1 read per storefront request** (the options row), bounded to one by the per-request
  memo. It fails soft to Tempered, so a slow or failing options table costs latency, never an error
  page.
- **Screenshot suites multiply per theme.** The infrastructure change records a Playwright baseline of
  today's Tempered (375 and 1280 wide, light and dark, seeded demo data) and must match it with
  `maxDiffPixels: 0` after the refactor. Every later theme PR brings its own set via `?theme=`. Markup
  rules that apply to every theme become `test.each(themes)` sweeps.
- **The Worker bundle grows by each theme's server code.** Every theme's views are statically imported
  by the registry, so they all ship in the Worker even though only one renders. CSS and fonts do not
  grow the page (Decision 8). Acceptable at six themes; revisit if the list grows much further.
- **Edge caching must key on theme.** Storefront HTML is not edge-cached today (SSR responses carry no
  cacheable headers; ADR-0003's `private, no-store` covers the plugin route JSON, not these pages). If
  it ever is, the cache key must include the active theme, or a theme switch must purge it. Otherwise
  buyers see the old theme after a switch.
- **The theme list is a build-time fact.** Adding or removing a theme is a site rebuild. Switching
  between built themes is not. A stored id that a later build drops falls back to Tempered, not to an
  error.
- **Existing tests change deliberately, not silently.** `page-css` (which asserts `styles/` holds only
  `tokens.css`), `fonts-config`, `tokens-css`, `base-layout*` and `checkout-client-js` are updated in
  the PR that moves what they assert, with the reason in that PR.
- **Delivery order.** This record first. Then `[Site]` infrastructure that moves Tempered into it
  with no visual change (baseline first, then refactor, then pixel and rendered-HTML diffs); then
  `[Site]` commerce views, so the cart, checkout, pay, order and account pages render through the
  theme too, still Tempered only; then the admin `[Plugin]` — the Settings "Store theme" radio, and a
  Themes screen; then one `[Site]` change per theme carrying its layout, every view, `theme.css`,
  fonts and signature motion. No theme ships with views missing; Decision 7's Tempered fallback stays
  as the safety rule.

## Amendment 2026-09-30 — the Themes screen and the admin-only live preview

- **Where a merchant picks a theme.** The admin gains a Themes screen (screenshot cards, Activate,
  Live preview) — a React page on `otta-console`, ruled in
  [ADR-0014's 2026-09-30 amendment](./0014-second-native-descriptor-for-react-admin.md). The Settings
  "Store theme" radio stays as the Block Kit fallback; both write through one function.
- **The manifest carries more.** Each `src/themes/manifest.ts` entry adds a one-line `description`
  and a `preview` path (`/theme-previews/<id>.webp`, a same-origin static asset under `public/`).
  Both ride the existing `__OTTA_STORE_THEMES__` define; the plugin rejects a preview that is not a
  same-origin absolute image path. Previews are regenerated by `pnpm capture:theme-previews`
  (1200×900 WebP from a 2× capture of each home page on the seeded demo, signed out), and a test
  fails a theme whose file is missing or the wrong size.
- **A production preview, for admins only.** Beside the dev-only `?theme=`, the site honours
  `?preview_theme=<id>` in production when `Astro.locals.user` is enabled and has role ≥ 50 (ADMIN)
  and the id is a shipped theme. `src/middleware.ts` applies it (`src/lib/theme-preview.ts` decides
  it): a session cookie `otta_theme_preview` (HttpOnly, SameSite=Lax, Path=/, Secure outside dev)
  carries it across in-frame links under the same rule; `?preview_theme=off` clears it for anyone
  and redirects to the clean URL (with `&silent=1`, the Themes screen's hidden exit, it answers an
  empty 200 instead); every previewed response, and every exit, is `Cache-Control: private,
  no-store` **and** opted out of Astro's route cache (`context.cache.set(false)`, as EmDash does for
  its own session-specific responses; a preview calls it again after the page renders, since a
  page's own cache hint re-enables it) — the header alone does not keep a response out of a route
  cache such as Workers Cache. Once a route cache exists, a URL already cached for shoppers is
  served before middleware runs, so a previewing admin can see the live theme there (it fails
  safe).
  Anyone else sending the parameter or the cookie gets the stored theme, and a cookie nobody may use
  is cleared. The storefront shows a theme-neutral "Previewing … — not live · Exit preview" pill (no
  client JS; ADR-0012's fence is unchanged), rendered by the shell, not by any theme — views stay
  presentation-only.
- **Framing.** The admin frames the storefront same-origin. The admin's production CSP
  (`default-src 'self'`) permits that, and storefront pages get EmDash's baseline
  `X-Frame-Options: SAMEORIGIN` (its `finalizeResponse`) and no `frame-ancestors`, which permits
  exactly this same-origin frame. A deployment that tightens framing must keep same-origin allowed,
  or the overlay's "Open in new tab" is the only way to preview.

## Amendment 2026-09-30 — the opt-in chrome bag read

- **What changes.** The Consequences' "one extra D1 read per storefront request" still holds for every
  theme that does not opt in. A theme whose chrome draws the cart's LINES outside `/cart` (a drawer,
  a strip) may set `chrome.cartLines` on its `ThemeModule`. For that theme only, the shell
  (`layouts/Storefront.astro`) makes one fail-soft cart read (`lib/bag.ts`) on non-checkout pages
  whose chrome has a cart link — one dispatch, without the dispatcher's BUSY retry — plus one
  batched, request-cached content read for the lines' names and pictures when the cart has lines,
  and hands the result to the Layout as `ChromeModel.bag`. No other theme pays anything, and a theme
  that does not draw the lines must not set it.
- **A page that drew a bag is per-shopper and must never be shared-cached.** For an opted-in theme,
  `src/middleware.ts` sends any storefront HTML requested with a cart cookie `Cache-Control:
  private, no-store` and opts it out of Astro's route cache (`context.cache.set(false)`, before and
  again after the page renders), so one shopper's lines can never be stored and replayed to another.
  Other themes' caching is untouched.
- **What does not change.** Views and Layouts still never read cookies, cart ids or the request
  (Decision 6): the shell reads the cart cookie and the theme receives a finished model. The read
  fails soft — an unreadable, throwing or BUSY read is `state: "unreadable"`, never an error page or
  a 503. It is skipped on `/cart`, `/checkout`, `/checkout/pay` and `/orders/<id>`. Holds in the bag
  are static wall-clock copy; the countdown script stays `/cart`'s alone (ADR-0012).

## Note 2026-10-01 — five themes moved out of this repo

Not a change to the decision, only to which themes this repo ships. `plinth`, `pressing`, `batch`,
`jumble` and `counter` were removed from `sites/staging` (views, layouts, sheets, art, vendored fonts,
preview screenshots and their manifest, registry and font entries); they are moving to a dedicated
themes repo, seeded from git history at `fca5cbc` (`git show fca5cbc:sites/staging/src/themes/<id>`).
Decision 10's list now reads as history: only `tempered` ships here, and it remains the default and
the fallback. A stored `settings:storeTheme` naming a removed id falls back to Tempered, as the
Consequences already state for any id a later build drops.

The theme system stays whole — the contract, manifest, registry, resolver, shell, the admin preview,
the opt-in chrome bag read (`chrome.cartLines`, `lib/bag.ts`, `forms/CartLineFields.astro`), the
`__OTTA_STORE_THEMES__` define, the plugin's Store theme setting and the admin Themes screen — as the
host side external themes will plug into. Mechanisms no shipped theme exercises today (the bag read,
the preview of a non-default theme) are covered by an in-test fixture theme rather than dropped.

## Amendment 2026-10-02 — no theme choice in the admin

With one theme shipping here (the note of 2026-10-01), a theme picker offers a single option, and
the product owner wants none from the start: external themes will come from the separate themes
repo, for a merchant who asks for one. So the admin-facing half of this decision is removed:

- **Removed:** the React **Themes** screen (`otta-console` `/themes`, its `themes.list` read and
  `themes:activate` write), the admin-only **live preview** (`?preview_theme`, its session cookie,
  the "Previewing …" pill and the middleware branch that decided it), the Settings **"Store theme"**
  radio and its `save-theme` action, and the `__OTTA_STORE_THEMES__` define that fed both pickers.
  Decision 2 and the 2026-09-30 Themes-screen amendment are retired with them.
- **Kept, unchanged:** the contract, manifest, registry, shell, the opt-in chrome bag read, the dev
  `?theme=` override and the resolver — which still reads the stored `settings:storeTheme` and falls
  back to Tempered. That read is the hook an external theme uses: whatever installs one registers it
  here and activates it; until then every request renders Tempered.

Reopens this amendment: a second theme shipping in this repo, or a request for merchants to choose
one in the admin — at which point a picker is designed for it, not restored by default.

