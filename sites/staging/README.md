# @urumi/site-staging

The Urumi **staging storefront + admin**: an EmDash site on Cloudflare Workers
(`urumi-store-staging`) with D1 (`urumi-cms`) + R2 (`urumi-media`), and the Urumi plugin
registered **trusted in-process** — no plugin sandbox, no Worker Loaders, Workers **free**
plan. See [ADR-0004](../../adr/0004-trusted-in-process-deployment.md) for why that is
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

First request runs the CMS migrations and applies `seed/seed.json` (products collection +
sample entries) to an empty database. `/products` renders the catalog; a stopped commerce
service degrades to a content-only catalog with a notice — never a crash.

## The COMMERCE_SERVICE_URL build-time contract

`COMMERCE_SERVICE_URL` is read **at build time** in `astro.config.ts` and baked into two
places: the plugin bundle (Vite define → `@urumi/plugin`'s manifest) and the plugin
descriptor's `allowedHosts` (the `ctx.http` egress gate). **Changing the service URL means
rebuild + redeploy.** There is no runtime override.

## Deploy runbook

Resources (`urumi-cms` D1, `urumi-media` R2) already exist and their ids are committed in
`wrangler.jsonc` — do not re-run `d1 create`/`r2 bucket create`.

1. `wrangler whoami` — confirm the right account and token.
2. Generate and store the encryption secret (never committed, never echoed into logs;
   back it up in a password manager):

   ```bash
   npx emdash secrets generate
   wrangler secret put EMDASH_ENCRYPTION_KEY   # paste interactively
   ```

3. Build with the real service URL (see contract above):

   ```bash
   COMMERCE_SERVICE_URL=https://<service>.workers.dev pnpm --filter @urumi/site-staging build
   ```

4. Deploy from `sites/staging`: `wrangler deploy`.
5. Hit the site once — the first request runs migrations and applies the seed (one-time
   latency is expected).
6. **Deploy-then-claim, immediately:** open `https://urumi-store-staging.<subdomain>.workers.dev/_emdash/admin`
   and complete the setup wizard **in the same session** — the first visitor to complete
   setup becomes the admin. Do not deploy and walk away. Optional hardening if the window
   worries you: put Cloudflare Access in front of `/_emdash/*` until setup is claimed,
   then remove it.
7. Smoke: `/products` renders the seeded catalog; create + publish a product in the admin
   and watch the service log the sync upsert; price it via the Product data panel;
   add-to-cart sets `urumi_cart` and creates a hold.
8. `wrangler tail` — first boot should be clean (migrations + seed, no errors).

### Failed-first-boot recovery

The seed applies only to an **empty** D1 database. If the first boot fails midway (partial
migration/seed), do not retry in place:

1. `wrangler d1 delete urumi-cms` and `wrangler d1 create urumi-cms`.
2. Update `database_id` in `wrangler.jsonc` with the new id.
3. Redeploy and claim the admin again (steps 4–6).

(Precedent: em-dash `demos/cloudflare/scripts/reset-db.sh` does exactly this
delete → create → id-rewrite → redeploy dance.)

## Notes

- **Phase 4 storefront surface is a follow-up task:** the service now has
  checkout/payments/orders/entitlements and the plugin gained a public
  `entitlements/download` authorization route, but this site deliberately stays
  catalog + cart. The checkout page, the x402 payment gate (designed to live at THIS
  Astro page layer), and the digital-download delivery page (the plugin route
  authorizes; the site serves the bytes / signed URL) are not built yet — a separate
  site task.
- **Cron** is `* * * * *` (EmDash scheduled publishing is minute-granular; free-plan D1
  limits unaffected). May be relaxed — see the comment in `wrangler.jsonc`.
- **`session: "auto"`** on the D1 adapter is inert until read replication is enabled on
  the database account-side; harmless before, free latency win after. Do not remove.
- **`SERVICE_API_TOKEN` follow-up:** the commerce service has an auth gate for its API
  token, but `HttpCommerceClient` does not send one yet. Keep the token **unset** on the
  service until the plugin threads it through; enabling it early would 401 every
  storefront call.
- No secrets anywhere in this package: `.env` is gitignored, `.env.example` holds
  placeholders, `wrangler.jsonc` `vars` must never grow a secret-shaped key (pinned by
  `test/wrangler-config.test.ts`).
