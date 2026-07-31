# @otta-sh/site-staging

The Otta **staging storefront + admin**: an EmDash site on Cloudflare Workers backed by
a D1 content database and an R2 media bucket, with the Otta plugin registered **trusted
in-process** — no plugin sandbox, no Worker Loaders, Workers **free** plan. See [ADR-0006](../../adr/0006-trusted-in-process-deployment.md) for why that is
allowed and what stays forbidden.

Pages are thin theme shims per [ADR-0003](../../adr/0003-storefront-plugin-routes.md): the
CMS query runs in the page, the plugin's public routes return JSON view models in-process
(`locals.emdash.handlePublicPluginApiRoute`), the page renders HTML. The `/cart/*` POST
endpoints own the `otta_cart` cookie (the plugin returns a cookie *descriptor*; the
endpoint applies it verbatim) and forward form-embedded idempotency keys — they never mint
one at POST time, so a double-submit replays instead of duplicating.

## Local development

```bash
# 1. Start the commerce service (repo root; point PG_CONNECTION_STRING at your
#    own local test Postgres). tsx, not the built dist bin: the unpublished
#    workspace exports point at TS sources (#44).
#    Warning: the default Postgres port, 5432 (no "55" prefix), is production —
#    never point this at it. The local test database is `otta` on 127.0.0.1:55432.
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta \
  pnpm dlx tsx@4 packages/service/src/index.ts

# 2. Run the site against it:
COMMERCE_SERVICE_URL=http://127.0.0.1:3000 pnpm --filter @otta-sh/site-staging dev
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

## The STRIPE_PUBLIC_KEY build-time contract

The checkout's Payment Element needs a Stripe **publishable** key, and it is baked the same
way (`astro.config.ts` → a Vite `define`): shell env → `sites/staging/.env` → absent.
**Changing it means rebuild + redeploy.** The variable is **`STRIPE_PUBLIC_KEY`** — the name
matters, see below. It is not put in wrangler `vars` because the guard test forbids any
`vars` key matching `/SECRET|KEY|TOKEN|PASSWORD/i`, and that guard is worth keeping.

Three behaviours, deliberately distinct:

| `STRIPE_PUBLIC_KEY` | What happens |
|---|---|
| a valid `pk_test_…` / `pk_live_…` | full checkout: review → pay → confirmation |
| **unset** | `/checkout` renders review + totals, says "Card payment isn't set up on this store yet.", and creates **no order** (the endpoint refuses too, not just the button) |
| set but malformed | **the build FAILS** |

That last row is the point. An absent key and a *misspelt variable name* look identical at
runtime — both degrade quietly while a valid key may sit unread — so a present-but-malformed
value throws instead of degrading, and `test/checkout-config.test.ts` pins the variable's
exact spelling as test data. See [ADR-0012](../../adr/0012-storefront-checkout-loads-stripe-elements-in-the-browser.md).

**A build without the key tree-shakes the payment step away entirely** (the branch is
constant-folded). That is correct, but it means any QA of the payment step must build *with*
the key.

## Deploying

The deploy runbook for this site lives in the root [`DEPLOYMENT.md`](../../DEPLOYMENT.md):
resource creation, secrets, the build/deploy ordering, first boot + claim, and
failed-first-boot recovery are §3 (Shape B); the workers.dev networking constraints and
the flag⇒session-off pairing invariant are §3.5; the secrets/token checklist — including
why `SERVICE_API_TOKEN` must stay unset for now — is §4.

## Notes

- **The checkout is built** (ADR-0012): `/checkout` (review + honest totals + contact and
  ship-to), `POST /checkout/place`, `/checkout/pay` (the Payment Element — **the only
  client JavaScript on this site**, and `js.stripe.com` the only third-party origin), and
  `/orders/<orderId>` (the capability-URL confirmation page, which polls with a bounded
  `<meta http-equiv="refresh">` and never claims "paid" on the strength of Stripe's
  redirect — the webhook is the sole authority). `POST /checkout/new-cart` is the way out
  of the dead-cart trap. `allowedHosts` is unchanged: browser→Stripe is not plugin egress.
- **Still a follow-up:** the x402 payment gate (designed to live at THIS Astro page layer)
  and the digital-download delivery page (the plugin route authorizes; the site serves the
  bytes / signed URL). Note for that task: `entitlements/download` is a public existence oracle
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
