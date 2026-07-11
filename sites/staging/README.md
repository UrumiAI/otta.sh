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
# 1. Start the commerce service (repo root; LOCAL TEST Postgres on
#    :55432 — never :5432, that tunnels to production). tsx, not the built
#    dist bin: the unpublished workspace exports point at TS sources.
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/urumi_test \
  pnpm dlx tsx packages/service/src/index.ts

# 2. Run the site against it:
COMMERCE_SERVICE_URL=http://127.0.0.1:3000 pnpm --filter @urumi/site-staging dev
```

In `astro dev` the fastest path to a populated catalog is the dev-only bypass, which
applies the full seed including the 3 sample products:
`/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`. What first boot does and does
not seed in a real deployment is covered in [`DEPLOYMENT.md`](../../DEPLOYMENT.md) §1.

## The COMMERCE_SERVICE_URL build-time contract

`COMMERCE_SERVICE_URL` is read **at build time** in `astro.config.ts` and baked into the
plugin bundle and the plugin descriptor's `allowedHosts` (the `ctx.http` egress gate).
**Changing the service URL means rebuild + redeploy** — there is no runtime override. The
full contract lives in [`DEPLOYMENT.md`](../../DEPLOYMENT.md) §1.

## Deploying

The deploy runbook for this site lives in the root [`DEPLOYMENT.md`](../../DEPLOYMENT.md):
resource creation, secrets, the build/deploy ordering, first boot + claim, and
failed-first-boot recovery are §3 (Shape B); the workers.dev networking constraints and
the flag⇒session-off pairing invariant are §3.5; the secrets/token checklist — including
why `SERVICE_API_TOKEN` must stay unset for now — is §4.

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
- No secrets anywhere in this package: `.env` is gitignored, `.env.example` holds
  placeholders, `wrangler.jsonc` `vars` must never grow a secret-shaped key (pinned by
  `test/wrangler-config.test.ts`).
