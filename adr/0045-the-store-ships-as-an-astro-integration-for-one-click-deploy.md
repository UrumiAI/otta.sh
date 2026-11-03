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
   - serves `/scripts/*.js` in dev and copies them into the client output on build, so their URLs
     do not change;
   - runs the same build guards against the project's wrangler config: downloads bucket privacy
     (issue #376), the `EMAIL` binding for a configured sender (ADR-0043), the refusal of
     `STRIPE_PUBLIC_KEY` (issue #498) and the build-path and secret scrub (issues #121, #584),
     now rooted at the Astro project root instead of the nearest `pnpm-workspace.yaml`;
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
5. **The template is a separate public repository** (13 files: config, two one-line re-exports,
   README, Dependabot). It uses npm with a committed `package-lock.json`, and pins exact versions of
   `@urumi.ai/otta-store`, the plugin, the admin package, `emdash` and `@emdash-cms/cloudflare`,
   because the modules EmDash generates import them from the project root. Updates arrive as one
   grouped Dependabot pull request, which Workers Builds deploys once it is merged.
6. **The template's wrangler config declares what the build actually deploys.** That includes
   `SESSION` (EmDash keeps signed-in users in the Astro session) and `IMAGES` (the
   `@astrojs/cloudflare` 14 default image service binds it). The adapter would add both to its
   generated config anyway, but declared, the button provisions `SESSION`, and `IMAGES` is
   visible. `RATE_LIMIT_AUTH` and `RATE_LIMIT_WRITES` are on, so cash on delivery (ADR-0044) can be
   offered; `send_email` stays commented out (ADR-0043).
7. **Customisation goes through the CMS and Store settings, not code.** That means the site
   title, tagline, menus and products, plus payments, tax and shipping. Tempered stays the only
   theme (ADR-0024, 2026-10-15 amendment), and overriding a single page is not supported.

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
