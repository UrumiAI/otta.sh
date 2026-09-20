# Deploying Otta

How to stand up a working Otta store from a fresh clone. Architecture background lives in
[`README.md`](./README.md); design decisions in [`adr/`](./adr/). This guide is
self-contained — section references like "§2" point inside this file.

---

## 0. What you are deploying

Otta is **one deployable and one database**: the storefront site (`sites/staging`) — an
EmDash CMS site with the Otta plugin registered trusted, running commerce **in-process**
inside the same Worker. There is no separate commerce service and no second database:
commerce truth lives in the host's per-plugin document store on the site's own D1 database,
alongside CMS content ([ADR-0018](./adr/0018-plugin-owns-commerce-truth-in-process.md),
[ADR-0019](./adr/0019-commerce-aggregates-are-one-document-each.md),
[ADR-0020](./adr/0020-one-deployable-plugin-owns-commerce-truth.md)).

`sites/staging` is the reference site: copy it for your own store rather than treating it as
staging-only.

> **Status honesty.** The commerce layer is feature-complete: catalog, inventory, cart,
> checkout, orders, customers with magic-link auth, Stripe + x402 payments, tax, shipping,
> discounts, entitlements, reporting, and settings. The reference **storefront**
> deliberately covers **catalog + cart only**. Two page surfaces are not built yet: the
> checkout/payment/download pages (issue #27) and the customer account/login pages (a
> parallel follow-up scoped in the site package's README — no issue yet). Deploying today
> gives you a browsable catalog and carts with real inventory holds; completing a purchase
> end-to-end means building the #27 surface. When #27 and the account-pages task close, this
> banner shrinks to a version note.

## 1. Universal contracts

Three rules hold. Everything else in this guide is a consequence of them.

- **Deploy-then-claim.** A freshly deployed site is unclaimed: **the first visitor to
  complete the setup wizard becomes the admin.** Claim it immediately after the first
  request, in the same session. The wizard's passkey step requires a WebAuthn **secure
  context** — HTTPS, or `localhost` (see §2.2). If the unclaimed window worries
  you, front `/_emdash/*` with Cloudflare Access until setup is claimed, then remove it.
- **Seed reality.** The site's first request runs the CMS migrations and applies the seed's
  **schema, settings, and menus only**. Sample content (the 3 demo products) is applied
  **only** when the setup wizard is completed with "include sample content" checked. An
  empty `/products` page right after first boot is **healthy, not a failed boot**.
- **Secrets model.** There is one deployable, so there is one place secrets can live — and
  two stores inside it (§3). Two are **Worker secrets** (`wrangler secret put`):
  `EMDASH_ENCRYPTION_KEY` and `OTTA_WH_TOKEN`. Every payment and email **credential** is
  provisioned by the operator in the admin console's **Settings** page and held in
  **write-only plugin `kv`** under `settings:*` — persisted only on a non-empty submit,
  never rendered back into a block, read through a fail-closed reader. Nothing
  secret-shaped ever goes in a tracked `wrangler.jsonc` (pinned by the site's config tests,
  which reject any `vars` key matching `/SECRET|KEY|TOKEN|PASSWORD/i`).

## 2. Cloudflare Workers (free tier)

The site as a Worker, with commerce running in-process inside it. This shape is
deploy-verified and is what `sites/staging` is built for.

### 2.0 Cost preconditions

The free-tier claim rests on two deliberate choices — undo either of them and you are on a
paid plan:

- **The plugin runs trusted in-process** — no `worker_loaders` binding. Worker Loaders (the
  plugin-sandbox runner) are the cost pivot that flips the account onto Workers Paid. See
  [ADR-0006](./adr/0006-trusted-in-process-deployment.md) for why this is allowed and what
  stays forbidden.
- **No Cloudflare Images or Stream.** Media lives in R2; the site uses Astro's built-in
  image service (the config deliberately does not set `imageService: "cloudflare"` — that is
  the paid resizing product).

The site's single `* * * * *` cron touches only D1, within free limits (§5).

### 2.1 The site Worker

1. **Create the content resources** (from `sites/staging`):

   ```bash
   wrangler whoami                                # confirm the right account
   wrangler d1 create YOUR-D1-DATABASE-NAME       # prints the database_id to paste in
   wrangler r2 bucket create your-media-bucket
   ```

2. **Fill in the local config.** Copy `sites/staging/wrangler.jsonc` (also a template) to
   `wrangler.local.jsonc` (gitignored) and set your Worker `name` (over `my-otta-store`),
   D1 `database_name`/`database_id`, and R2 `bucket_name`. Leave the
   `global_fetch_strictly_public` compatibility flag alone — §2.4 explains it.

3. **Set the site's one secret** (the only secret first boot needs):

   ```bash
   npx emdash secrets generate
   wrangler secret put EMDASH_ENCRYPTION_KEY --config wrangler.local.jsonc   # paste; back it up
   ```

   The site's "never `--config`" rule (step 5) applies to **deploy only** — deploy must
   follow the build's `.wrangler/deploy` redirect. `wrangler secret put` never reads that
   redirect: without `--config` it defaults to the tracked template and targets a Worker
   named `my-otta-store` — a phantom; your real Worker would then first-boot without its
   only required secret.

4. **Build the site.** The Cloudflare adapter reads `wrangler.local.jsonc` at **build**
   time (`astro.config.ts` passes it as `configPath`), so the build, not the deploy, is
   where your Worker name, D1, and R2 config becomes real. Commerce runs in-process, so
   there is no service URL to bake in:

   ```bash
   pnpm --filter @otta-sh/site-staging build
   ```

5. **Deploy plain — never `--config` here** (from `sites/staging`):

   ```bash
   wrangler deploy
   ```

   This follows the `.wrangler/deploy` redirect to the adapter-generated dist config, which
   already carries your `wrangler.local.jsonc` values from step 4's build. **Deploy does not
   rebuild** — step 4 owns the build, so your Worker name, D1, and R2 bindings are never
   silently the tracked template's placeholders.

### 2.2 First boot and claim

1. **Hit the site once** — `https://<your-worker>.<your-subdomain>.workers.dev/`. The first
   request runs the CMS migrations and applies the seed's schema/settings/menus (one-time
   latency is expected). Per §1, `/products` is empty at this point — that is healthy.
2. **Claim immediately:** open `/_emdash/admin` and complete the setup wizard **in the same
   session, with "include sample content" enabled** (that is what applies the 3 sample
   products; skip it and you simply start with an empty catalog). The first visitor to
   complete setup becomes the admin — do not deploy and walk away. workers.dev is HTTPS, so
   the passkey step's secure-context requirement (§1) is already met.
3. **Smoke:** `/products` renders the sample catalog (or the friendly empty state); create
   and publish a product in the admin and watch `wrangler tail` log the sync upsert; price
   it in the admin's **Pricing & inventory** page (the CMS holds no commercial data);
   add-to-cart sets the `otta_cart` cookie and creates a hold. The three sample products
   are content-only until you price them — the seed fires no content hooks, so either
   price them in Pricing & inventory or run `sites/staging/scripts/seed-demo-commerce.ts`
   against the SITE. It drives the site's own admin API — the route the Pricing &
   inventory page uses — so it needs only the site URL and a token that can read the CMS
   and call that route:

   ```bash
   SITE_URL=https://<your-site-worker>.workers.dev \
   EMDASH_TOKEN=<an admin API token> \
     pnpm dlx tsx@4 sites/staging/scripts/seed-demo-commerce.ts
   ```

   The script is safe to re-run: it reads each product first and skips any that already
   has a SKU, so it never overwrites a price set in Pricing & inventory.
4. **`wrangler tail`** (from `sites/staging`) — first boot should be clean: migrations +
   schema seed, no errors.

### 2.3 Failed-first-boot recovery

**Only for an actual failed boot** — errors in `wrangler tail` (migration failures, partial
schema seed). An empty `/products` catalog is NOT a failed boot (§2.2 step 1); never reset a
healthy database. The seed applies only to an **empty** D1 database, so a midway failure
cannot be retried in place:

1. `wrangler d1 delete YOUR-D1-DATABASE-NAME` and `wrangler d1 create YOUR-D1-DATABASE-NAME`.
2. Update `database_id` in your `wrangler.local.jsonc` with the new id.
3. **Rebuild** (the wrangler config is read at build time — §2.1 step 4), redeploy, then
   claim the admin again (§2.1 step 5 → §2.2).

### 2.4 The `global_fetch_strictly_public` pairing invariant

> The site's `wrangler.jsonc` carries the `global_fetch_strictly_public` compatibility flag.
> That flag silently breaks the D1 Sessions API — its internal routing request is blocked and
> **every SSR request hangs with nothing in the logs** — so `d1()` in the site config must
> keep `session` **off** while the flag is present. Both halves are pinned by tests:
> `sites/staging/test/site-config.test.ts` (session stays off, placeholder equality) and
> `sites/staging/test/wrangler-config.test.ts` (flag presence, template hygiene). Do not
> "fix" one side without the other.
>
> A **custom domain** on the site (issue #32) is what unlocks zone-level WAF rules (§3).

## 3. Secrets & tokens checklist

Two of these are **Worker secrets** on the site (`wrangler secret put`); the rest are
**plugin credentials** the operator types into the admin console's **Settings** page, which
persists them to write-only plugin `kv` under `settings:*`. On Workers, **every `wrangler
secret put` below** needs `--config wrangler.local.jsonc`: without it, wrangler defaults to
the tracked template and uploads the secret to the placeholder-named Worker, not yours. In
order of appearance in a deployment's life:

| Secret | Where it lives | Required? | When to set |
|---|---|---|---|
| `EMDASH_ENCRYPTION_KEY` | Worker secret | yes | before the site's first boot |
| `OTTA_WH_TOKEN` | Worker secret **+** admin Settings (same value, both halves) | optional outer gate on the settle routes | with the Stripe webhook secret |
| Stripe webhook signing secret | admin Settings (`settings:stripeWebhookSecret`) | for Stripe payments | before enabling Stripe |
| Stripe secret key | admin Settings (`settings:stripeSecretKey`) | to take **real** payments (and to refund) | with the webhook secret |
| x402 pay-to + facilitator credential | admin Settings | for x402 | see the x402 box |
| Email API key (with the `EMAIL_API_URL` / `EMAIL_FROM` build-time values) | admin Settings | optional | when wiring real email |

- **`EMDASH_ENCRYPTION_KEY`** — generate with `npx emdash secrets generate`; never committed,
  never echoed into logs; **back it up in a password manager** (it protects the CMS's
  encrypted data — losing it strands that data).

> **The Stripe webhook endpoint is public by design, and permanently site-owned.**
> Stripe delivers to `POST /webhooks/stripe` on the site (`sites/staging/src/pages/webhooks/stripe.ts`)
> — register **that** path in the Stripe dashboard. It is a transport shim: it reads the raw
> delivered bytes, never parses them, attaches the edge token, and dispatches the plugin's
> **public** `webhooks/stripe/settle` route in-process, replaying the status the plugin asks
> for so Stripe's retry behaviour stays correct. It holds no Stripe secret and verifies no
> signature itself.
>
> **The trust anchor is the Stripe HMAC**, verified unconditionally inside the plugin route
> against `settings:stripeWebhookSecret` — never switchable off by any token. A webhook is
> always unauthenticated, and an anonymous request only ever reaches the host's *public*
> plugin-route dispatcher, so the route being public is structural, not a relaxation.
>
> **`OTTA_WH_TOKEN` is the cheap outer gate** in front of that anchor: it lets the public
> route refuse an *unattributed* request before it reads another kv key, builds a gateway or
> opens a store. Provision the same value on both halves — `wrangler secret put
> OTTA_WH_TOKEN` on the site and the matching field in admin Settings. Unset on the plugin
> side, the gate **passes through** (degrading to "cryptographic anchor only", never to
> "nothing works" and never to "nothing is checked"); set on the plugin side but unset on
> the site, **every delivery 401s** — that is the dangerous direction, and the reason the
> endpoint replays the 401 into Stripe's dashboard rather than swallowing it.

- **Stripe** — until the webhook signing secret is set, the settle route answers
  `NOT_CONFIGURED`. **The Stripe secret key decides whether checkout can actually be paid.**
  With it, `createIntent` performs a real `POST /v1/payment_intents` — the buyer gets a LIVE
  client secret, `metadata[order_id]` carries the settlement key the webhook is matched on,
  and the checkout `Idempotency-Key` travels as Stripe's native one — and refunds become
  available. **Without it**, `createIntent` mints an OFFLINE deterministic handle
  (`pi_<orderId>` plus a fake client secret that no Stripe.js/Elements can ever pay). That
  stays a warning, never a boot failure: staging and e2e run offline on purpose. A
  live-intent failure (Stripe down or rejecting) answers **502 `PAYMENT_INTENT_FAILED`**; the
  `pending` order is kept deliberately — retrying with the same `Idempotency-Key` re-issues
  the *same* PaymentIntent, and the order-expiry sweep reaps it at the checkout TTL
  (releasing stock and any coupon use) if it never gets paid.

> **Live Stripe is TWO-DECIMAL currencies only.** Otta stores money as integer minor units
> at hundredths scale everywhere, while Stripe expects `amount` in each currency's own
> smallest unit. For **zero-decimal** currencies (JPY, KRW, CLP, VND, BIF, DJF, GNF, KMF,
> MGA, PYG, RWF, UGX, VUV, XAF, XOF, XPF) that would charge the buyer **100×**, and for
> **three-decimal** ones (BHD, JOD, KWD, OMR, TND) it is the mirror error — so the live
> `createIntent` **refuses them before any network call**, answering 502
> `PAYMENT_INTENT_FAILED` (provider code `unsupported_currency`). Do not price a catalog in
> those currencies against a secret-key-configured deployment; the offline (no-secret-key)
> path is unaffected. Lifting this needs an exponent-aware money boundary, not an adapter
> tweak — the deny-list is `STRIPE_UNSUPPORTED_CURRENCIES` in
> `packages/payments-stripe/src/index.ts`.

> **x402 settles against a real facilitator over `ctx.http`.** The configured facilitator
> credential goes **on the wire** as `Authorization: Bearer …` to the facilitator host, so
> provision a credential that was minted to be sent. The facilitator host must be in the
> plugin's `allowedHosts` — it is seeded at **build** time from the site's Astro config, not
> from `kv`, so changing facilitators is a rebuild, not a settings edit. The pay-to address
> and the accepted-networks list (default `eip155:8453`) are configuration, not credentials,
> and live alongside it in Settings.

- **Email** — with no email API URL configured the console sender is used: emails are
  **logged, not delivered** (visible in `wrangler tail`). The API URL and From address are
  build-time values (the URL also seeds `allowedHosts`); the API key is a Settings
  credential. Set the storefront base URL so magic-link login emails carry a clickable URL
  (unset, they carry raw challenge credentials only).

## 4. Egress and `allowedHosts`

The plugin's only egress is `ctx.http.fetch`, gated by the descriptor's `allowedHosts`
allowlist (capability `network:request`). That allowlist is resolved at **build** time
(`packages/plugin/src/manifest.ts`, fed by `sites/staging/astro.config.ts`) and contains:

| Host | When |
|---|---|
| `api.stripe.com` | always — the one constant entry |
| the email API host | when an email API URL is configured |
| the x402 facilitator host | when a facilitator URL is configured |

Because it is build-time, adding a provider means a rebuild and redeploy — a Settings edit
alone cannot widen it. That is deliberate: the allowlist is the perimeter, and an operator
editing a text field should not be able to move it.

## 5. Operations & scaling

**Cron.** Two cadences, and they do different jobs. The **site's** Cron Trigger is
`* * * * *` — that drives the host's cron *executor*, which claims due rows from its own
task table. The **plugin** registers one task, `commerce-sweeps`, due every `*/15`; the
executor fires the plugin's `cron` hook when it comes due. One task drives all nine sweep
legs: they share a store composition and a clock, and splitting them would only put nine
rows in contention on the same documents.

Every leg is **idempotent** and runs in its own try/catch with its own label, so a leg that
throws cannot starve the eight beside it; a tick always returns a summary, and each leg logs
one line on success and one `console.error` on failure (visible in `wrangler tail`). Per
[ADR-0019](./adr/0019-commerce-aggregates-are-one-document-each.md), these sweepers are not
an optimization — a coupling that spans two aggregates is made idempotently completable
rather than transactional, so **a missing sweeper is a correctness bug**. The site's cron
may be relaxed (e.g. `*/5 * * * *`) if cron noise ever matters more than publish latency,
but relaxing it past the task's own `*/15` delays every sweep.

**Scaling.** Commerce truth is one document per aggregate in the site's D1 database, written
by compare-and-set; every command carries an idempotency key the store enforces once-only,
and the sweeps are idempotent, so concurrent isolates racing the same sweep never
double-release or double-send. A hot aggregate therefore retries rather than blocking: the
contention budget is a measured number recorded in ADR-0019, not a hope. The scaling ceiling
is that single D1 database.

## 6. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Every SSR request hangs, nothing in logs | `global_fetch_strictly_public` + D1 `session` both on — pairing invariant violated (§2.4); turn `session` off |
| `/products` empty right after deploy | Healthy (§1) — sample content lands via the wizard checkbox, not first boot |
| `POST /webhooks/stripe` reports `NOT_CONFIGURED` | The Stripe webhook signing secret is unset — provision it in admin Settings (§3) |
| Every Stripe delivery 401s | `OTTA_WH_TOKEN` set on the plugin side but not on the site (or the values differ) — §3 |
| Sweeps never run | Nothing has bootstrapped the schedule, or the runtime wired no cron executor — check that the site's Cron Trigger is present and hit a storefront route once (§5) |
| An outbound call to Stripe / the email provider / the x402 facilitator never leaves | The host is not in the build-time `allowedHosts` allowlist (§4) — rebuild and redeploy |
