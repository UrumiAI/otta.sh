# @urumi/site-staging

The Urumi **staging storefront + admin**: an EmDash site on Cloudflare Workers backed by
a D1 content database and an R2 media bucket, with the Urumi plugin registered **trusted
in-process** — no plugin sandbox, no Worker Loaders, Workers **free** plan. See [ADR-0006](../../adr/0006-trusted-in-process-deployment.md) for why that is
allowed and what stays forbidden.

Pages are thin theme shims per [ADR-0003](../../adr/0003-storefront-plugin-routes.md): the
CMS query runs in the page, the plugin's public routes return JSON view models in-process
(`locals.emdash.handlePublicPluginApiRoute`), the page renders HTML. The `/cart/*` POST
endpoints own the `urumi_cart` cookie (the plugin returns a cookie *descriptor*; the
endpoint applies it verbatim) and forward form-embedded idempotency keys — they never mint
one at POST time, so a double-submit replays instead of duplicating.

## Local development

```bash
# 1. Build + start the commerce service (repo root; LOCAL TEST Postgres on
#    :55432 — never :5432, that tunnels to production):
pnpm --filter @urumi/service build
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/urumi_test \
  node packages/service/dist/index.mjs

# 2. Run the site against it:
COMMERCE_SERVICE_URL=http://127.0.0.1:3000 pnpm --filter @urumi/site-staging dev
```

First request runs the CMS migrations and applies `seed/seed.json`'s **schema, settings,
and menus** to an empty database — sample content entries are NOT applied at first boot
(`applySeed` defaults `includeContent: false`); they land only when the setup wizard is
completed **with sample content included**. In `astro dev` the fastest path is the
dev-only bypass, which applies the full seed including the 3 sample products:
`/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`. `/products` then renders the
catalog; a stopped commerce service degrades to a content-only catalog with a notice —
never a crash.

## The COMMERCE_SERVICE_URL build-time contract

`COMMERCE_SERVICE_URL` is read **at build time** in `astro.config.ts` and baked into two
places: the plugin bundle (Vite define → `@urumi/plugin`'s manifest) and the plugin
descriptor's `allowedHosts` (the `ctx.http` egress gate). **Changing the service URL means
rebuild + redeploy.** There is no runtime override.

## Deploy runbook

The tracked `wrangler.jsonc` is a **template** with placeholder resource values — real
Worker/D1/R2 identifiers are never committed. Your filled-in copy lives in the
gitignored `wrangler.local.jsonc`.

1. **Fill in your resource ids.** Copy `wrangler.jsonc` → `wrangler.local.jsonc` (or
   edit `wrangler.jsonc` in place if your fork is private) and set your own Worker
   `name`, D1 `database_name`/`database_id`, and R2 `bucket_name`. When
   `wrangler.local.jsonc` exists, the build picks it up automatically
   (`astro.config.ts` passes it to the Cloudflare adapter as `configPath`). Fresh
   account:

   ```bash
   wrangler whoami                            # confirm the right account and token
   wrangler d1 create <your-d1-name>          # prints the database_id to paste in
   wrangler r2 bucket create <your-media-bucket>
   ```

2. Generate and store the encryption secret (never committed, never echoed into logs;
   back it up in a password manager):

   ```bash
   npx emdash secrets generate
   wrangler secret put EMDASH_ENCRYPTION_KEY   # paste interactively
   ```

3. Build with the real service URL (see contract above):

   ```bash
   COMMERCE_SERVICE_URL=https://<your-service>.<your-subdomain>.workers.dev pnpm --filter @urumi/site-staging build
   ```

4. Deploy from `sites/staging`: plain `wrangler deploy` (or `pnpm deploy`) — it follows
   the `.wrangler/deploy` redirect to the adapter-generated dist config, which already
   carries your `wrangler.local.jsonc` values from step 3's build. (Do NOT pass
   `--config wrangler.local.jsonc`: that bypasses the redirect and rebundles the raw
   worker source.) Deploy does NOT rebuild; step 3 owns the build so the service URL is
   never silently the placeholder.
5. Hit the site once — the first request runs migrations and applies the seed's
   **schema/settings/menus** (one-time latency is expected). Sample content entries are
   NOT applied here — an empty `/products` at this point is healthy, not a failed boot.
6. **Deploy-then-claim, immediately:** open `https://<your-worker>.<your-subdomain>.workers.dev/_emdash/admin`
   and complete the setup wizard **in the same session, with "include sample content"
   enabled** (that is what applies the 3 sample products; skip it and you simply start
   with an empty catalog) — the first visitor to complete setup becomes the admin. Do
   not deploy and walk away. Optional hardening if the window worries you: put
   Cloudflare Access in front of `/_emdash/*` until setup is claimed, then remove it.
7. Smoke: `/products` renders the sample catalog (or the friendly empty state if you
   skipped sample content); create + publish a product in the admin and watch the
   service log the sync upsert; price it via the Product data panel; add-to-cart sets
   `urumi_cart` and creates a hold.
8. `wrangler tail` — first boot should be clean (migrations + schema seed, no errors).

### Failed-first-boot recovery

Only for an **actual failed boot** — errors in `wrangler tail` (migration failures,
partial schema seed). An empty `/products` catalog is NOT a failed boot (see step 5);
do not reset a healthy database. The seed applies only to an **empty** D1 database, so a
midway failure cannot be retried in place:

1. `wrangler d1 delete <your-d1-name>` and `wrangler d1 create <your-d1-name>`.
2. Update `database_id` in your `wrangler.local.jsonc` (or edited-in-place
   `wrangler.jsonc`) with the new id.
3. Rebuild (the wrangler config is read at build time — step 3) and redeploy, then
   claim the admin again (steps 4–6).

(Precedent: em-dash `demos/cloudflare/scripts/reset-db.sh` does exactly this
delete → create → id-rewrite → redeploy dance.)

## Notes

- **Phase 4 storefront surface is a follow-up task:** the service now has
  checkout/payments/orders/entitlements and the plugin gained a public
  `entitlements/download` authorization route, but this site deliberately stays
  catalog + cart. The checkout page, the x402 payment gate (designed to live at THIS
  Astro page layer), and the digital-download delivery page (the plugin route
  authorizes; the site serves the bytes / signed URL) are not built yet — a separate
  site task. Note for that task: `entitlements/download` is a public existence oracle
  (it confirms whether an orderId/buyerRef/sku combination is entitled) — the delivery
  page must rate-limit and/or tokenize access to it rather than exposing raw probing.
- **Phase 5 customer-account pages are also a follow-up** (same scope note — no theme
  pages built here). The plugin now serves five public account routes the theme is
  expected to surface with login/account pages plus a first-party session cookie (the
  plugin is session-stateless; the bearer token is route INPUT, so the theme layer owns
  the cookie exactly like the cart shim does): `storefront/account/login/request`,
  `storefront/account/login/verify`, `storefront/account/orders`,
  `storefront/account/order`, `storefront/account/addresses`.
- **Cron** is `* * * * *` (EmDash scheduled publishing is minute-granular; free-plan D1
  limits unaffected). May be relaxed — see the comment in `wrangler.jsonc`.
- **workers.dev→workers.dev subrequests are blocked** (deploy-verified): a Worker's
  `fetch` to another `*.workers.dev` host never leaves Cloudflare — it is stubbed with a
  404 (parallel `wrangler tail`s showed the request never reached the service; direct
  curl worked). The site therefore ships the `global_fetch_strictly_public`
  compatibility flag, which is what lets its `ctx.http` calls reach the service Worker.
- **D1 `session` must stay OFF** while `global_fetch_strictly_public` is present: the
  flag silently blocks the D1 Sessions API's internal routing request and every SSR
  request hangs with nothing in the logs (em-dash `deployment/cloudflare.mdx:121-130`,
  emdash issue #1273). Read replication was inert here anyway (not enabled
  account-side). The flag⇒session-off pairing is pinned by the site-config test. For
  production, the alternative is a **custom domain on the commerce service** — custom
  domains are not subject to the workers.dev subrequest block, so the flag could be
  dropped and `session: "auto"` re-enabled.
- **`SERVICE_API_TOKEN` write gate (ADR-0007):** the plugin now threads the write-gate
  token to the service as the dedicated **`X-Service-Token`** header (NOT
  `Authorization: Bearer`, which is the customer session credential). All three plugin
  clients read it at runtime from write-only plugin kv (`settings:serviceToken`),
  admin-provisioned via the masked **"Service token (X-Service-Token)"** field on the
  Settings page. **Deploy ordering:** provision `settings:serviceToken` in this env's
  plugin kv (via the Settings form) **before** flipping this env's `SERVICE_API_TOKEN`
  service secret. The reverse order 401s every storefront call in the window — and note
  the gate blocks POST *reads* too (`getCommerceBatch` for PDP/PLP and the login pre-auth
  POSTs), so an unprovisioned token breaks catalog rendering and login, not just writes.
  Both are now runtime actions (no redeploy), closable in seconds.
- **Rotating `SERVICE_API_TOKEN`:** rotate in lockstep. Set the new `settings:serviceToken`
  in plugin kv FIRST (the service still accepts the old token), THEN rotate the service
  secret. Rotating the service secret without updating kv silently 401s every plugin call —
  and the content-sync hooks are fire-and-forget with **no reconcile cron yet**, so a
  failed sync is logged and then lost until the product is saved again. The service token is
  the plugin's most sensitive value: a kv compromise yields the whole write surface.
- No secrets anywhere in this package: `.env` is gitignored, `.env.example` holds
  placeholders, `wrangler.jsonc` `vars` must never grow a secret-shaped key (pinned by
  `test/wrangler-config.test.ts`).
