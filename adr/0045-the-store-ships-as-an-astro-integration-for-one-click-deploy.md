# 0045. The store ships as an Astro integration package for one-click deploy

- Status: accepted
- Date: 2026-11-03

## Context

README.md promises a one-click Cloudflare Workers deployment. Cloudflare's "Deploy to Cloudflare"
button clones a **public** repository into the merchant's GitHub or GitLab account (a clone, not a
fork, so it never syncs upstream), provisions the D1, R2 and KV resources its wrangler config
declares, prompts for the secrets in `.dev.vars.example`, and connects Workers Builds, which
installs, runs the `build` script and runs the `deploy` script on every push. Monorepos are not
supported well: the app must be self-contained in the cloned directory.

Until now the store was `sites/staging`: 148 source files (pages, middleware, theme, components,
lib, fonts, seed, public scripts) plus a 338-line `astro.config.ts` that carried the build guards
(downloads bucket privacy, email binding, the retired Stripe build key), the egress and email
build settings and the Vite settings the plugin needs. Cloning that would give every merchant a copy
of the store's code, and every fix after that would be a merge in their repository.

Options considered:

1. **Clone `sites/staging` as the template.** Smallest change now. Every update is a code merge
   the merchant has to do by hand. Rejected.
2. **A thin template whose files re-export a published "site" package.** Astro routes are files,
   so the template would carry one wrapper per route (29) plus the middleware and the config.
   Every new or renamed route is a template change, the code merge we are avoiding. Rejected.
3. **Point Astro's `srcDir` and `publicDir` into the installed package.** Almost no code moves, but
   it relies on Astro and Vite treating a `src/` under `node_modules` as project source, which is
   not documented, and it leaves the merchant no file of their own. Rejected; the fallback if
   option 4 had hit a blocker.
4. **An Astro integration package**, `@urumi.ai/otta-store`. It injects the routes, the middleware,
   the fonts, the public scripts and the Vite settings, and runs the build guards. EmDash 1.3.1
   ships the same way: its `emdash()` integration injects about 100 routes and a middleware from
   `node_modules`, in this same build.

## Decision

1. The store's source moves from `sites/staging` to a new publishable package,
   **`@urumi.ai/otta-store`** at `sites/store/`, with its unit tests. (`sites/`, not `packages/`:
   the store is the site layer, which may import `emdash` and `react`; the dependency rules on
   `packages/` forbid both, and they stay as they are.) It ships its `.astro` and `.ts` runtime
   **source**, which Vite compiles in the merchant's build; the plugin's build-time defines need
   it bundled anyway. Only the integration entry is compiled, because Astro loads
   `astro.config.mjs` through Node, and Node does not strip types from files under
   `node_modules`.
2. Its default export, **`otta(options)`**, is an Astro integration. It:
   - registers `react()` and `emdash(...)` with the options `sites/staging` used;
   - injects one route per file under the package's `src/pages` (the same patterns Astro's file
     router gave them) and adds the site middleware with `order: "post"`, after EmDash's `"pre"`
     middlewares, which is where `src/middleware.ts` ran;
   - sets `output`, `image`, `fonts` and the Vite `define`, `ssr.noExternal` and `optimizeDeps`
     settings that `sites/staging/astro.config.ts` set;
   - ships the package's `public/` (the first-party `/scripts/*.js` and the sample products'
     `/playground-products/*.jpg`, which the seed names): served in dev, copied into the
     client output on build, at the same URLs;
   - runs the same build guards against the project's wrangler config: downloads bucket privacy
     (issue #376), the `EMAIL` binding for a configured sender (ADR-0043), the refusal of
     `STRIPE_PUBLIC_KEY` (issue #498) and the build-path and secret scrub (issues #121, #584),
     now rooted at the Astro project root instead of the nearest `pnpm-workspace.yaml`, plus
     two checks a template site needs: EmDash will find the store's seed, and the site's
     `src/live.config.ts` defines the collections itself (see "Found while verifying");
   - takes `emailFrom`, `emailFromName` and `extraAllowedHosts` as options, falling back to the
     `OTTA_EMAIL_FROM`, `OTTA_EMAIL_FROM_NAME` and `OTTA_EXTRA_ALLOWED_HOSTS` build variables
     (shell, then `.env`), with the same validation as before.
3. **The template contract number.** `otta({ template: N })` is required. The package exports the
   number it expects, `OTTA_TEMPLATE_CONTRACT` (1 today). A release that needs the merchant's own
   files to change (a new binding in `wrangler.jsonc`, a new required file, a new pinned
   dependency) raises it. A build whose `template` differs fails before any bundling with:

   > `@urumi.ai/otta-store <version> needs template contract <expected>, but astro.config.mjs passes`
   > `otta({ template: <given> }). Your store's own files must change before this version can`
   > `build. Follow "Template contract <expected>" in the Otta upgrade notes`
   > `(https://github.com/UrumiAI/otta.sh/blob/main/UPGRADING.md), then set template: <expected>.`
   > `Until then the store keeps serving the last version that built.`

   On Workers Builds a failed build deploys nothing, so the live Worker keeps serving the last good
   version. A release that keeps the number is a pure dependency bump.
4. **`sites/staging` becomes a consumer** of the package, shaped like the template, plus what only
   this repository needs: the e2e wrangler config, the e2e Stripe-offline switch, the
   persisted-state option, `wrangler.local.jsonc` and the playground config. The e2e suite
   therefore runs the same integration a merchant runs.
5. **The template is a separate public repository** (13 files: config, `src/worker.ts` (a
   one-line re-export), `src/live.config.ts` (three lines), README, Dependabot). It uses npm with a committed `package-lock.json`, and pins exact versions of
   `@urumi.ai/otta-store`, the plugin, the admin package, `emdash` and `@emdash-cms/cloudflare`,
   because the modules EmDash generates import them from the project root. Updates arrive as one
   grouped Dependabot pull request, which Workers Builds deploys once it is merged.

   **One copy of each runtime.** `@urumi.ai/otta-store` declares EmDash,
   `@emdash-cms/cloudflare`, Astro, `@astrojs/cloudflare`, `@astrojs/react`, React, the plugin
   and the admin package as **peer dependencies**, never dependencies (EmDash and its
   Cloudflare package exactly; the Astro and React packages to the tested minor with `~`; the
   two Otta packages at the release). As dependencies, a site on another EmDash would get a
   second copy nested under the package, and the Worker would carry two EmDash runtimes. As
   peers, npm refuses the install (`ERESOLVE`), which was checked with the packed tarballs and
   `emdash@1.4.0`. So Dependabot is limited to `@urumi.ai/*` (one group) and Wrangler. A release
   that moves the other pins raises the template contract, and its upgrade notes list the new
   versions.
6. **The template's wrangler config declares what the build actually deploys.** That includes
   `SESSION` (EmDash keeps signed-in users in the Astro session) and `IMAGES` (the
   `@astrojs/cloudflare` 14 default image service binds it). The adapter would add both to its
   generated config anyway, but declared, the button provisions `SESSION`, and `IMAGES` is
   visible. `RATE_LIMIT_AUTH` and `RATE_LIMIT_WRITES` are on, so cash on delivery (ADR-0044) can be
   offered; their fixed `namespace_id`s are shared by every Worker in the account that uses them,
   which the template README says. `send_email` stays commented out (ADR-0043).
   `"preview_urls": false`: a preview version shares the production D1 and would run its
   migrations on its first request. The README's "turn off non-production branch builds" is the
   second safeguard.
7. **Customisation goes through the CMS and Store settings, not code.** That means the site
   title, tagline, menus and products, plus payments, tax and shipping. Tempered stays the only
   theme (ADR-0024, 2026-10-15 amendment), and overriding a single page is not supported. A
   site's own `src/middleware.ts` runs between EmDash's middleware and Otta's, so one that
   answers a request without `next()` skips Otta's cross-site check and the setup-link gate for
   it; the template README and UPGRADING.md say so.
8. **The package's build checks, as hardened after review:**
   - the build fails on ANY key of Astro's inlined env object outside Astro's own keys and
     `PUBLIC_*` (a clean build inlines only empty objects), with the builder's `PATH` value as a
     second layer;
   - the package's `public/` files never replace a site's own: a site file at one of their
     paths fails setup by name, the build copy is per file and exclusive, and in dev they answer
     GET and HEAD only;
   - the live-collections check ignores comments; page discovery skips `_*`, `*.d.ts` and
     `*.test.ts` as Astro's router does; the scrub's root also stops at an npm or yarn
     workspace root;
   - messages the package ships name no path in this repository, and link the documentation by
     full URL. The `[site-staging]` log prefix stays: tests pin it, and DEPLOYMENT.md's
     troubleshooting tells operators to search the logs for it;
   - every publishable package builds in `prepack`, so `pnpm pack` never packs a stale `dist/`.

## Found while verifying (2026-11-03)

The template was built from `pnpm pack` tarballs of all eight packages, installed with npm,
and run under `wrangler dev`: claimed through the logged setup link, cash on delivery turned on
in Store settings, a COD order placed, shipped and marked paid, and a fake `0.2.1` installed by
a version bump alone. Three things only the packed form showed:

- **Astro guards live collections twice.** It hands the real `defineLiveCollection` only to
  the site's own `src/live.config.ts` (it compares the importer's path), and the real one
  reads its caller's file name off the stack and throws unless it contains `live.config`.
  Re-exporting finished collections from the package failed every catalog read in the
  built Worker ("Top-level await in module is unsettled"); passing the function in from the
  site file fixed the build but still failed under `astro dev`, where the caller was
  `src/live-config.ts`. The package's module is now named `src/live.config.ts` (exported as
  `@urumi.ai/otta-store/live-config`) and exports `ottaLiveCollections(define)`; the site
  file passes `defineLiveCollection` in; `otta()` fails the build, saying what to write, when
  the site file does not; and a test pins the module's name.
- **Astro's env plugin decides by a module's text, comments included.** A mention of
  `import.meta.env` that is not a `.KEY` member read (the plugin's `?.DEV`, and comments
  about it, kept in the published `dist`) makes it inline every build variable whose name
  appears in the module. The template's Worker carried the builder's HOME, PATH and TERM.
  The plugin now reads only `import.meta.env.DEV` and never names the bare object, tests scan
  the plugin's and the store's shipped source for any other spelling, and the build scrub
  fails a bundle that contains the builder's `PATH`.
- **The seed's sample photos lived in `sites/staging/public`**, so a template store showed
  empty image boxes. They ship with the package now.

`package-lock.json` is the one template file that cannot exist yet: npm cannot lock versions
the registry does not have. It is generated when `0.2.0` is published, before the template
repository is made public.

## A failed first boot

The first request to a new store runs EmDash's migrations and then the auto-seed. In EmDash
1.3.1 (`emdash-runtime.ts`, `database/migration-lock.ts`):

- **The seed fails or is cut off.** This is retried by itself. The seed runs only while
  `emdash:auto_seed_complete` is unset, applies with `onConflict: "skip"` and is marked complete
  last, so the next request finishes what is missing. Nothing needs deleting.
- **A migration throws.** EmDash records the failure, answers every request with "Database
  initialization is backing off after a recent migration failure" for 30 seconds, then tries
  again. Migrations already applied are recorded and skipped, so a transient failure (a D1 blip)
  clears by itself.
- **The Worker is killed in the middle of a migration** (the Workers Free CPU limit, an isolate
  eviction). EmDash keeps its migration lock in a D1 row (`_emdash_migrations_lock`). A holder
  that never released it leaves the lock held, and every later request fails with "The migration
  lock has been held since …" plus the link to EmDash's release-the-lock steps. This does **not**
  clear by itself. The fix is one statement in the D1 console, not a new database, unless the
  interrupted migration had half-applied a step that cannot run twice.

Deleting and recreating the database (DEPLOYMENT.md §2.3) is therefore the last resort, not the
first step. Whether a fresh store's first boot fits in Workers Free's CPU limit has **not** been
measured: `wrangler dev` does not enforce it. It is a known risk until a real Free account has run
the button, and the template README tells the merchant how to release the lock.

## Launch gates

The Deploy to Cloudflare button goes into README.md only after all of these:

1. `@urumi.ai/*` 0.2.0 is published to npm, and the template's `package-lock.json` is generated
   and committed right after, before the template repository is made public.
2. The links merchants follow resolve publicly: otta.sh is public, or `OTTA_UPGRADE_NOTES_URL`
   and the documentation URLs in the package's messages and README point somewhere public.
3. A real Cloudflare account has run the button, and these are checked:
   - the button creates the D1, R2 and KV resources and rewrites the template's zero-ID
     placeholders (`wrangler.jsonc` keeps them until then);
   - the `IMAGES` and rate-limit bindings deploy and work on Workers Free;
   - a new store's first boot (every migration plus the seed) fits Workers Free's CPU limit.

## Consequences

- An update is a version bump. No code merge, as long as the template contract stays the same.
- A release that changes the template contract needs an entry in the upgrade notes. Until the
  merchant follows it, the build fails, and the live store keeps the last good version.
- **Workers Builds' non-production branch builds are a data risk.** A Dependabot branch's preview
  version shares the production D1, and opening its URL runs that release's forward-only
  migrations against production data. The template README and DEPLOYMENT.md tell the merchant to
  turn non-production branch builds off.
- The store's tests move with its source. Tests that read `astro.config.ts` as text now read the
  integration's source, with the same assertions.
- These Cloudflare facts must be checked on a real account before the button goes into
  README.md: provisioning and ID write-back, the secret prompt, first-boot CPU on Free, and the
  `IMAGES` and rate-limit bindings on Workers Free.
- Reopen this decision if Astro or EmDash stops supporting routes injected from `node_modules`, or
  if merchants need to change code that the options cannot reach.
