# 0003. Storefront pages are plugin-owned public routes (JSON view models + thin theme pages)

- Status: accepted
- Date: 2026-07-10
- Refines: ADR-0001 (the plugin's storefront surface); consequences for Phases 2–4 plans

## Context

The Phase 2 plan (§4.1) assumed storefront PDP/PLP are **EmDash-native content pages**, with
the plugin injecting price/availability fragments and Product/Offer JSON-LD via the
`page:fragments` hook. That assumption was flagged as unverified; the Phase 2 platform spike
checked it against EmDash source (paths relative to the EmDash repo root) and it does not
hold:

- `page:fragments` is **trusted-plugin-only**. The hook is labelled trusted-only in source
  (`packages/core/src/plugins/types.ts:952`); the fragment collector states "Sandboxed
  plugins are never invoked" (`packages/core/src/page/fragments.ts:5`); the runtime's
  contribution pass invokes sandboxed plugins for `page:metadata` **only** — annotated
  "Sandboxed plugins — metadata only, never fragments"
  (`packages/core/src/emdash-runtime.ts:3600-3638`); and bundling a sandboxed plugin that
  declares the hook warns "trusted-only and will not work in sandboxed mode"
  (`packages/plugin-cli/src/bundle/api.ts:226-230`). The plugin-authoring docs say the same
  (`skills/creating-plugins/references/hooks.md:412-414`).
- The one public-page hook a sandboxed plugin *can* register, `page:metadata`, contributes
  only `meta` / `property` / `link` / `jsonld` kinds
  (`packages/core/src/plugins/types.ts:933-941`) — no HTML kind, so it cannot render a
  price/stock/"not purchasable" body fragment.
- Running Urumi as a **trusted** plugin to regain `page:fragments` is not an option:
  sandbox-cleanliness is a Urumi non-negotiable (`CLAUDE.md`, `DEVELOPMENT.md` §5 — "if it
  only works trusted, it's broken"). ADR-0001's whole shape depends on it.

So the plugin must own the storefront surface through its **routes**. That raises a
sub-question this ADR settles rather than defers: *how does a sandboxed plugin's public
route serve a storefront page?* Verified against source:

- Plugin routes are mounted at `/_emdash/api/plugins/{pluginId}/{route}` by a catch-all
  Astro endpoint that handles **GET, POST, PUT, PATCH, DELETE**
  (`packages/core/src/astro/routes/api/plugins/[pluginId]/[...path].ts:88-93`); routes
  declared `public: true` skip auth/CSRF entirely (same file, lines 40-66;
  `getPluginRouteMeta`, `packages/core/src/emdash-runtime.ts:3205-3247`).
- The response is **always a JSON envelope**: success returns
  `Response.json({ data }, { headers: { "Cache-Control": "private, no-store" } })` via
  `apiSuccess()` (`[...path].ts:84`, `packages/core/src/api/error.ts:21-53`). A sandboxed
  route handler returns a value, never a `Response` — it **cannot serve raw HTML** with a
  `text/html` content type (`handleSandboxedRoute`,
  `packages/core/src/emdash-runtime.ts:3535-3573`).
- There is **no clean-path mount** for sandboxed plugins: routes outside `/_emdash/` exist
  only for config-level (i.e. trusted) `authProviders`
  (`packages/core/src/astro/middleware.ts:443-455`). A sandboxed plugin cannot own
  `/products` or `/products/:slug` directly.
- The platform's own precedent for "sandboxable plugin powering a public page": the
  **forms plugin**. Its public route serves the form *definition* as JSON, and an Astro
  component server-renders the HTML by invoking the route **in-process** through
  `locals.emdash.handlePublicPluginApiRoute` — the dispatcher core exposes to SSR pages
  precisely for this (`packages/core/src/astro/middleware.ts:562-573`,
  `packages/core/src/plugin-utils.ts:34-44`,
  `packages/plugins/forms/src/astro/FormEmbed.astro:21-27`). No HTTP hop, no client-side
  fetch, fully server-rendered.

## Decision

**PDP and PLP are plugin-owned public routes returning JSON view models, rendered to HTML
by thin theme/template Astro pages at clean paths.** Concretely — option (b) of the
sub-question; option (a), serving full HTML at a clean path from the sandboxed plugin, is
not supported by the platform:

1. The Urumi plugin declares public storefront routes (manifest `routes` with
   `public: true`, the mechanism Phase 1 already uses for its admin routes), reachable at
   `GET /_emdash/api/plugins/urumi/storefront/{product|list}` with parameters via query
   string. Each handler performs the whole Phase-2 pipeline — CMS-content + commerce join,
   single batched commerce call, purchasability — and returns a **display-ready, localized
   JSON view model**: content fields, `purchasable`, formatted price string, availability,
   and the Product(+Offer) JSON-LD graph as data.
2. **Themes own the HTML.** A thin Astro page at the clean path (`/products`,
   `/products/[slug]`, shipped as a template/theme shim, like the forms plugin's
   `FormEmbed.astro`) fetches the view model in frontmatter — in-process via
   `handlePublicPluginApiRoute` when available, falling back to a server-side fetch of the
   public route — and renders markup plus a `<script type="application/ld+json">` from the
   view model's JSON-LD graph. Pages stay fully server-rendered; no SEO regression versus
   the fragment design.
3. **All storefront intelligence stays in the route handler**, not the theme shim: the
   shim maps a view model to markup and nothing else. This keeps the sandbox-tested surface
   (workerd) the authoritative one and keeps the theme layer replaceable.
4. **Phase 3 group E (add-to-cart)** hangs off the same surface: the PDP view model carries
   the `purchasable` flag and a marked extension slot; the add-to-cart affordance renders in
   that slot and submits to the plugin's (Phase 3) public cart routes — it is a slot within
   the plugin-owned PDP route's view model, not an EmDash-page fragment.
5. **Phase 4 (step 4.9 storefront seams)** — checkout/confirmation pages follow the same
   pattern: public plugin route owns the view model and orchestration; a theme page renders
   it. No new architecture arrives in Phase 4 for this.

Fallback noted: if EmDash later lets sandboxed plugins return raw responses or mount clean
paths, the route handlers already own complete view models — the theme shim thins toward
zero; nothing else moves. Conversely `page:metadata`'s `jsonld` kind (sandbox-reachable)
remains available as an additive channel for any product content that stays on EmDash-native
pages; it is not the primary JSON-LD path for PDP/PLP.

## Consequences

- **Phase 2 plan §7 steps 9/10 change shape, nothing else does.** The join utility,
  request-scoped batching loader, `formatMoney`, JSON-LD builder, batch port method, and
  `POST /catalog/commerce/batch` endpoint (steps 1–8) are transport-agnostic and land
  unchanged — exactly the insulation §4.1's fallback note designed for. Steps 9/10 are
  written as sandboxed route handlers (tested under workerd), not `page:fragments` handlers.
- **Phase 3 group E** targets the PDP view-model slot (above), and its cart routes were
  already planned as plugin routes — this ADR makes the storefront consistent with them.
- **A theme shim becomes part of the install story.** Like the forms plugin, rendering
  Urumi's storefront requires the site's Astro layer to include the (provided) PDP/PLP
  pages. Accepted tradeoff: it is the platform's own pattern, and it keeps HTML fully
  theme-customizable.
- **Plugin route responses are `private, no-store` JSON envelopes.** Fine for v1 (matches
  the Phase-2 decision of no cross-request caching); if catalog pages later need edge/ISR
  caching, that belongs to the theme-page layer, not the plugin route.
- The clean URLs (`/products/...`) are owned by the site/theme, so per-site route naming
  stays flexible; the plugin's stable contract is the view model, not the public path.
