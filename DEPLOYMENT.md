# Deploying Urumi

How to stand up a working Urumi store from a fresh clone: the commerce service plus a
storefront site, in either of the two supported shapes. Architecture background lives in
[`README.md`](./README.md); design decisions in [`adr/`](./adr/). This guide is
self-contained — section references like "§4" point inside this file.

---

## 0. What you are deploying

Urumi is **two deployables and two databases**:

1. **The commerce service** (`@urumi/service`) — a Hono REST API that owns all money and
   stock truth. It ships two entries from one codebase: a Node bin (`dist/index.mjs`
   post-publish; run via tsx from a checkout today — see §2.2) and a Cloudflare Worker
   (`src/worker.ts`). It needs a **Postgres** database and migrates itself forward on boot.
2. **The storefront site** (`sites/staging`) — an EmDash CMS site with the Urumi plugin
   registered trusted in-process. It needs a **content database of its own** (D1 on Workers),
   entirely separate from the commerce Postgres. `sites/staging` is the reference site: copy
   it for your own store rather than treating it as staging-only.

> **Status honesty.** The commerce **service** is feature-complete (Phases 0–7, per the root
> README): catalog, inventory, cart, checkout, orders, customers with magic-link auth,
> Stripe + x402 payments, tax, shipping, discounts, entitlements, reporting, and settings.
> The reference **storefront** deliberately covers **catalog + cart only**. Two page surfaces
> are not built yet: the checkout/payment/download pages (issue #27) and the customer
> account/login pages (a parallel follow-up scoped in the site package's README — no issue
> yet). Deploying today gives you a browsable catalog and carts with real inventory holds;
> completing a purchase end-to-end means building the #27 surface or driving the service API
> directly. When #27 and the account-pages task close, this banner shrinks to a version note.

| | Shape A | Shape B |
|---|---|---|
| Service runtime | Node process (§2.2) | Cloudflare Worker |
| Commerce DB | any Postgres you can reach | external Postgres via Hyperdrive |
| Site runtime | EmDash on Node (link-out, §2.5) | `sites/staging` on Workers **free** plan |
| Sweeps | self-intervals + one external driver (§2.4) | `*/15` cron runs all four (§6) |
| Starts at | §2 | §3 |

## 1. Universal contracts

Five rules hold in every shape. Everything else in this guide is a consequence of them.

- **Deploy order: service first, then site.** The site build needs the service's final URL
  (next bullet), so the service must exist — and answer `/health` — before you build the
  site.
- **`COMMERCE_SERVICE_URL` is a build-time contract.** The site reads it at **build** time
  in `astro.config.ts` and bakes it into two places: the plugin bundle (a Vite compile-time
  define) and the plugin descriptor's `allowedHosts` — the egress gate for `ctx.http`, which
  is the **only** path the plugin may use to reach the service. There is no runtime
  override: **changing the service URL means rebuild + redeploy of the site.** A build
  without the variable produces a deployable-but-inert commerce egress (the placeholder host
  is unreachable by design).
- **Deploy-then-claim.** A freshly deployed site is unclaimed: **the first visitor to
  complete the setup wizard becomes the admin.** Claim it immediately after the first
  request, in the same session. The wizard's passkey step requires a WebAuthn **secure
  context** — HTTPS, or `localhost` (see §2.5 and §3.3). If the unclaimed window worries
  you, front `/_emdash/*` with Cloudflare Access until setup is claimed, then remove it.
- **Seed reality.** The site's first request runs the CMS migrations and applies the seed's
  **schema, settings, and menus only**. Sample content (the 3 demo products) is applied
  **only** when the setup wizard is completed with "include sample content" checked. An
  empty `/products` page right after first boot is **healthy, not a failed boot**.
- **Secrets model.** Every payment and token secret lives **service-side** (§4). The site
  carries exactly one secret: `EMDASH_ENCRYPTION_KEY`. Nothing secret-shaped ever goes in a
  tracked `wrangler.jsonc` (pinned by the site's config tests).

## 2. Shape A — Node + Postgres

The service as a plain Node process against any Postgres you can reach. There is no
Node-hosted site in this repo — §2.5 covers your options for the storefront half.

### 2.0 Network posture

The Node bin listens on `PORT` (default 3000) on **all interfaces — it has no bind-address
knob**: the entry calls `serve({ fetch, port })` with no hostname parameter, and there is no
`HOST` env var — do not go looking for one. Issue #43 tracks adding it; once it closes, bind
to loopback directly and this paragraph becomes one line. Until then, keep the service off
the public network by external means: an OS firewall, a private network / VPC, or a
loopback-mapped container port (e.g. `-p 127.0.0.1:3000:3000`).

Expose nothing publicly until you enable Stripe; then expose **only** `POST
/webhooks/stripe` through a reverse-proxy path allowlist. Anything more exposes the write
surface described in §4 — which you close by provisioning `SERVICE_API_TOKEN` on both
sides (§4). Until that token is set the write surface is open:

> **Posture:** while `SERVICE_API_TOKEN` is unset, every mutating route is unauthenticated
> (§4). Treat a publicly reachable service whose gate is still open as non-production —
> test-mode payment credentials only, never live-mode Stripe keys on an open write surface.
> Provisioning the token on both sides (§4) closes the gate and lifts this restriction.

### 2.1 Provision Postgres

Managed or self-hosted both work — the suite runs against Postgres 16 in CI; older
versions are untested. Pooled vs direct: the service runs its own
`pg` pool and a Kysely migrator that use **prepared statements**, so give it a **direct
connection or a session-mode pooler**. A transaction-mode pooler (e.g. PgBouncer in
transaction mode) breaks prepared statements and will fail in confusing ways. Size the pool
conservatively; the database is the scaling arbiter (§6).

### 2.2 Run the service

The `@urumi/*` packages are not published yet, and inside the workspace their export maps
point at TypeScript sources — so from a checkout, run the Node entry with a TS-executing
runner rather than the built `dist/index.mjs` (that file is the entry for a future
published install; plain `node` cannot resolve its workspace imports today — issue #44;
when it closes, this step becomes `node dist/index.mjs`). From the repo root:

```bash
pnpm install
PG_CONNECTION_STRING=postgres://USER:PASSWORD@YOUR-DB-HOST:5432/YOUR-DB-NAME \
  pnpm dlx tsx@4 packages/service/src/index.ts
```

`PG_CONNECTION_STRING` is required — the entry throws at startup without it. Migrations run
automatically before the server starts listening (forward-only, idempotent). Smoke it:

```bash
curl http://127.0.0.1:3000/health
# {"ok":true}
```

### 2.3 Configure

All configuration is environment variables — see the reference table in §5 and the secrets
checklist in §4. The Node bin self-schedules two maintenance intervals out of the box: a
hold sweep (every 60s, `HOLD_SWEEP_INTERVAL_MS`) and an email-outbox drain + login-challenge
prune (every 30s, `EMAIL_DISPATCH_INTERVAL_MS`). Which brings us to the gap:

### 2.4 The order-expiry sweep gap

> **Caveat — issue #28.** The Node bin's self-intervals run hold sweeps, email dispatch, and
> login-challenge pruning — **order expiry is the one missing sweep**. Hold correctness does
> not depend on the timer (expiry is also lazy-on-read), but order expiry is clock-driven,
> so on Shape A you must drive it externally until #28 lands: set `INTERNAL_API_TOKEN` (§4)
> and run this on a schedule (cron, systemd timer — every 5–15 minutes is fine):
>
> ```bash
> curl -X POST -H "X-Internal-Token: $INTERNAL_API_TOKEN" \
>   http://127.0.0.1:3000/internal/expire-orders
> ```
>
> Fixed end-state: #28 adds the order-expiry leg to the Node self-interval; when it closes,
> delete the external cron and this box.

### 2.5 The site against a Node service

Three options, in increasing effort:

- **Point the Workers site at your Node service.** `sites/staging` happily targets any
  service URL: build it with `COMMERCE_SERVICE_URL=https://your-service.example.com` and
  deploy per §3.2. The service URL must be reachable **from Cloudflare's network** — which
  conflicts with §2.0's keep-it-private posture unless you expose it deliberately
  (provision the `SERVICE_API_TOKEN` write gate per §4 first).
- **Run an EmDash site on Node.** Follow EmDash's upstream Node deployment guide
  (`deployment/nodejs.mdx` in the [EmDash repo](https://github.com/emdash-cms/emdash)) and
  apply the Urumi deltas from `sites/staging`: register the plugin trusted via a descriptor
  (ADR-0006), bake `COMMERCE_SERVICE_URL` at build time, and port the theme pages + `/cart/*`
  cookie-shim endpoints. No Node-adapter site exists in this repo; this path is
  link-out-plus-deltas, not a tested recipe.
- Either way, **put HTTPS in front of the site before first boot**: the setup wizard's
  passkey step needs a WebAuthn secure context, which workers.dev gives you automatically
  but bare Node does not — terminate TLS first (the one exception: `localhost` is a secure
  context, so claiming over an SSH tunnel at `http://localhost` works).

## 3. Shape B — Cloudflare Workers (free tier)

Both deployables as Workers. This shape is deploy-verified and is what `sites/staging` is
built for.

### 3.0 Cost preconditions

The free-tier claim rests on three deliberate choices — undo any of them and you are on a
paid plan:

- **The plugin runs trusted in-process** — no `worker_loaders` binding. Worker Loaders (the
  plugin-sandbox runner) are the cost pivot that flips the account onto Workers Paid. See
  [ADR-0006](./adr/0006-trusted-in-process-deployment.md) for why this is allowed and what
  stays forbidden.
- **No Cloudflare Images or Stream.** Media lives in R2; the site uses Astro's built-in
  image service (the config deliberately does not set `imageService: "cloudflare"` — that is
  the paid resizing product).
- **The service cron is `*/15`**, not every minute, so a serverless Postgres origin (e.g.
  Neon's free tier) can autosuspend between ticks. The site's every-minute cron touches only
  D1, within free limits.

### 3.1 The service Worker

1. **Provision an external Postgres** (Neon, Supabase, or similar) and note its **direct
   (unpooled) connection string** — for Neon, uncheck the connection-pooling checkbox when
   copying it; for Supabase, take the "Direct connection" string, not the pooled ones. This
   is the opposite instinct from most serverless setups, and it is what Cloudflare's own
   provider guides for [Neon](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)
   and [Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
   instruct: **Hyperdrive owns the origin connection pool itself**, and a transaction-mode
   pooler in front of it breaks the prepared statements that the service's `pg` driver and
   Kysely migrator rely on.

2. **Create the Hyperdrive config with query caching disabled** (from `packages/service`):

   ```bash
   wrangler hyperdrive create urumi-commerce-db \
     --connection-string="postgres://USER:PASSWORD@YOUR-DB-HOST:5432/YOUR-DB-NAME" \
     --caching-disabled
   ```

   [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
   serves repeated reads from cache; the commerce API's read-after-write flows (place a
   hold, immediately re-read availability) must never see stale rows, so caching stays off.
   Note the config `id` (32 hex chars) the command prints.

3. **Fill in the local config.** The tracked `packages/service/wrangler.jsonc` is a
   **template** with placeholder values. Copy it to `wrangler.local.jsonc` (gitignored) and
   set your own Worker `name` (over the `my-urumi-commerce` placeholder) and your Hyperdrive
   `id` (over the all-zero placeholder). The origin credentials live in the Hyperdrive
   config platform-side — there is no `PG_CONNECTION_STRING` secret on Workers.

4. **Deploy with the local config, always** (from `packages/service`):

   ```bash
   wrangler deploy --config wrangler.local.jsonc
   ```

   > **The `--config` asymmetry — for `wrangler deploy`, the two deployables are exact
   > opposites:**
   >
   > | Deployable | Correct deploy command | What the wrong form does |
   > |---|---|---|
   > | service (`packages/service`) | `wrangler deploy --config wrangler.local.jsonc` | plain `wrangler deploy` — including the package's `pnpm deploy` script — reads the tracked **template** and deploys a Worker named `my-urumi-commerce` with the all-zero Hyperdrive id |
   > | site (`sites/staging`) | plain `wrangler deploy` (after the §3.2 build) | `wrangler deploy --config wrangler.local.jsonc` bypasses the `.wrangler/deploy` redirect to the adapter-generated config and tries to rebundle the raw worker source |
   >
   > The asymmetry covers **deploy only**. `wrangler secret put` always takes
   > `--config wrangler.local.jsonc`, on **both** deployables: it never reads the site's
   > build redirect, and without `--config` it defaults to the tracked template and
   > targets the placeholder-named Worker, not yours (§4).

5. **Smoke it:**

   ```bash
   curl https://<your-service>.<your-subdomain>.workers.dev/health
   # {"ok":true}
   ```

> **Secrets at this point:** set only `EMDASH_ENCRYPTION_KEY` (on the site, §3.2). Every
> other secret is optional at first boot — including `SERVICE_API_TOKEN`, whose write gate
> you provision in lockstep across the service secret and the plugin's kv once the site is
> up and claimed (§4).
>
> **Posture:** while `SERVICE_API_TOKEN` is unset the service's write surface is open (§4).
> Treat a publicly reachable service whose gate is still open as non-production — test-mode
> payment credentials only, never live-mode Stripe keys on an open write surface.

### 3.2 The site Worker

1. **Create the content resources** (from `sites/staging`):

   ```bash
   wrangler whoami                                # confirm the right account
   wrangler d1 create YOUR-D1-DATABASE-NAME       # prints the database_id to paste in
   wrangler r2 bucket create your-media-bucket
   ```

2. **Fill in the local config.** Copy `sites/staging/wrangler.jsonc` (also a template) to
   `wrangler.local.jsonc` (gitignored) and set your Worker `name` (over `my-urumi-store`),
   D1 `database_name`/`database_id`, and R2 `bucket_name`. Leave the
   `global_fetch_strictly_public` compatibility flag alone — §3.5 explains it.

3. **Set the site's one secret** (see the §3.1 callout — this is the only secret first boot
   needs):

   ```bash
   npx emdash secrets generate
   wrangler secret put EMDASH_ENCRYPTION_KEY --config wrangler.local.jsonc   # paste; back it up
   ```

   The site's "never `--config`" rule (step 5) applies to **deploy only** — deploy must
   follow the build's `.wrangler/deploy` redirect. `wrangler secret put` never reads that
   redirect: without `--config` it defaults to the tracked template and targets a Worker
   named `my-urumi-store` — a phantom; your real Worker would then first-boot without its
   only required secret.

4. **Build with the real service URL.** The Cloudflare adapter reads `wrangler.local.jsonc`
   at **build** time (`astro.config.ts` passes it as `configPath`), and the service URL is
   baked at build time (§1) — so the build, not the deploy, is where configuration becomes
   real:

   ```bash
   COMMERCE_SERVICE_URL=https://<your-service>.<your-subdomain>.workers.dev \
     pnpm --filter @urumi/site-staging build
   ```

5. **Deploy plain — never `--config` here** (from `sites/staging`):

   ```bash
   wrangler deploy
   ```

   This follows the `.wrangler/deploy` redirect to the adapter-generated dist config, which
   already carries your `wrangler.local.jsonc` values from step 4's build. **Deploy does not
   rebuild** — step 4 owns the build, so the baked service URL is never silently the
   placeholder. (See the asymmetry table in §3.1.)

### 3.3 First boot and claim

1. **Hit the site once** — `https://<your-worker>.<your-subdomain>.workers.dev/`. The first
   request runs the CMS migrations and applies the seed's schema/settings/menus (one-time
   latency is expected). Per §1, `/products` is empty at this point — that is healthy.
2. **Claim immediately:** open `/_emdash/admin` and complete the setup wizard **in the same
   session, with "include sample content" enabled** (that is what applies the 3 sample
   products; skip it and you simply start with an empty catalog). The first visitor to
   complete setup becomes the admin — do not deploy and walk away. workers.dev is HTTPS, so
   the passkey step's secure-context requirement (§1) is already met.
3. **Smoke:** `/products` renders the sample catalog (or the friendly empty state); create
   and publish a product in the admin and watch the service log the sync upsert; price it
   via the Product data panel; add-to-cart sets the `urumi_cart` cookie and creates a hold.
4. **`wrangler tail`** (from `sites/staging`) — first boot should be clean: migrations +
   schema seed, no errors.

### 3.4 Failed-first-boot recovery

**Only for an actual failed boot** — errors in `wrangler tail` (migration failures, partial
schema seed). An empty `/products` catalog is NOT a failed boot (§3.3 step 1); never reset a
healthy database. The seed applies only to an **empty** D1 database, so a midway failure
cannot be retried in place:

1. `wrangler d1 delete YOUR-D1-DATABASE-NAME` and `wrangler d1 create YOUR-D1-DATABASE-NAME`.
2. Update `database_id` in your `wrangler.local.jsonc` with the new id.
3. **Rebuild** (the wrangler config is read at build time — §3.2 step 4), redeploy, then
   claim the admin again (§3.2 step 5 → §3.3).

### 3.5 workers.dev networking — the #1 footgun

> **Why the site ships `global_fetch_strictly_public`.** Cloudflare blocks
> Worker→`*.workers.dev` subrequests and **stubs them with a 404** that never leaves
> Cloudflare (deploy-verified: parallel `wrangler tail`s showed the request never reached
> the service; direct curl worked). The site's `wrangler.jsonc` therefore carries the
> `global_fetch_strictly_public` compatibility flag, which is what lets its `ctx.http`
> calls reach a service Worker on workers.dev.
>
> **Pairing invariant:** that flag silently breaks the D1 Sessions API — its internal
> routing request is blocked and **every SSR request hangs with nothing in the logs** — so
> `d1()` in the site config must keep `session` **off** while the flag is present. Both
> halves are pinned by tests: `sites/staging/test/site-config.test.ts` (session stays off,
> placeholder equality) and `sites/staging/test/wrangler-config.test.ts` (flag presence,
> template hygiene). Do not "fix" one side without the other.
>
> Fixed end-state — issue #32: a **custom domain on the commerce service** (custom domains
> are not subject to the workers.dev subrequest block) lets the site drop the flag and
> re-enable `session: "auto"`, and deletes this box. A custom domain is also what unlocks
> zone-level WAF rules (§4).

## 4. Secrets & tokens checklist

All of these live on the **service** (Node env vars / `wrangler secret put`) except the
first (site) and the plugin-kv half of `SERVICE_API_TOKEN` (box below). On Workers, **every
`wrangler secret put` below — on either deployable — needs
`--config wrangler.local.jsonc`**: without it, wrangler defaults to the tracked template
and uploads the secret to the placeholder-named Worker, not yours (see the §3.1 asymmetry
note). In order of appearance in a deployment's life:

| Secret | Deployable | Required? | When to set |
|---|---|---|---|
| `EMDASH_ENCRYPTION_KEY` | site | yes | before the site's first boot |
| `INTERNAL_API_TOKEN` | service | Shape A: yes (§2.4); Shape B: for the admin reports/settings UI | any time |
| `SERVICE_API_TOKEN` | service + plugin kv | to close the write gate | in lockstep, **plugin kv first** (box below) |
| `STRIPE_WEBHOOK_SECRET` | service | for Stripe payments | before enabling Stripe |
| `STRIPE_SECRET_KEY` | service | to take **real** payments (and to refund) | with the webhook secret |
| `X402_PAYTO` + `X402_FACILITATOR_SECRET` | service | for x402 (non-production only today) | see fail-closed box |
| `EMAIL_API_KEY` (with `EMAIL_API_URL` / `EMAIL_FROM` vars) | service | optional | when wiring real email |

- **`EMDASH_ENCRYPTION_KEY`** — generate with `npx emdash secrets generate`; never committed,
  never echoed into logs; **back it up in a password manager** (it protects the CMS's
  encrypted data — losing it strands that data).

> **`SERVICE_API_TOKEN` — the write gate ([ADR-0007](./adr/0007-dedicated-service-token-header.md)).**
>
> When set, every non-GET/HEAD request to the service must carry the token in the dedicated
> **`X-Service-Token`** header — *not* `Authorization: Bearer`, which is the customer session
> credential. The storefront plugin threads it automatically: all three plugin clients read
> it at runtime from **write-only plugin kv** (`settings:serviceToken`), provisioned by an
> admin through the masked **"Service token (X-Service-Token)"** field on the plugin's
> Settings page — the secret never enters the plugin bundle.
>
> **Provisioning order — do not invert:** set `settings:serviceToken` in this env's plugin
> kv (the Settings form) **before** setting this env's `SERVICE_API_TOKEN` service secret.
> The reverse order 401s every storefront call in the window — and the gate covers POST
> *reads* too (the `getCommerceBatch` behind every PDP/PLP, and the login pre-auth POSTs),
> so an unprovisioned token breaks catalog rendering and login, not just cart writes. Both
> are runtime actions — no redeploy — so the window is closable in seconds.
>
> **Rotation — lockstep, kv first:** set the new `settings:serviceToken` in plugin kv (the
> service still accepts the old token), *then* rotate the service secret. Rotating the
> service secret without updating kv silently 401s every plugin call — and the content-sync
> hooks are fire-and-forget with **no reconcile cron yet**, so a failed sync is logged and
> then lost until the product is saved again. The service token is the plugin's most
> sensitive value: a kv compromise yields the whole write surface.
>
> **While unset the write surface is open:** every mutating route is unauthenticated — cart
> creation and line writes, `POST /checkout/orders`, `/inventory/*` mutations, entitlement
> grants — so on a publicly reachable URL anyone who finds it can create orders and burn
> inventory holds. The Worker entry logs a warning once per isolate when the gate is open;
> **the Node entry is silent** — issue #42 tracks warning parity. Provision the token (both
> sides, above) before exposing the service publicly (§2.0, §3.1).
>
> **Interplay with `INTERNAL_API_TOKEN`:** routes behind both gates (e.g. `PUT /settings`,
> the `/admin/*` writes) require **both** headers when both secrets are set — the plugin's
> admin console forwards `X-Service-Token` alongside its `X-Internal-Token`.

- **`INTERNAL_API_TOKEN`** — the shared secret for the operational surface. Unset, those
  endpoints answer **503** (disabled — never silently open): `POST /internal/expire-holds`,
  `POST /internal/expire-orders`, `POST /internal/dispatch-emails`, and — **reads
  included** (ADR-0010) — the entire `/admin/*`, `/reports/*` and `/settings` surface. That
  means the `/admin/*` order transition and rules CRUD, the rules **GET** reads (shipping
  zones/methods/rates, tax classes/rates, coupon lookup by code), and **both** verbs on
  `/settings`. `SERVICE_API_TOKEN`'s write gate exempts GET/HEAD, so this token is the only
  thing that closes those reads. Callers send it as
  `X-Internal-Token`: your §2.4 cron on Shape A, and the plugin's **admin console** — its
  reports/settings screens take the token as admin input and forward it on each request.
  The Worker cron path needs no token (it calls the domain directly, §6).
- **Stripe** — `STRIPE_WEBHOOK_SECRET` wires the Stripe gateway; until set,
  `POST /webhooks/stripe` answers 503. The webhook URL is **public by design**: it is the
  single exemption from the `X-Service-Token` write gate, authenticated instead by
  `Stripe-Signature` HMAC over the raw body (Stripe cannot carry our token).
  **`STRIPE_SECRET_KEY` decides whether checkout can actually be paid.** With it,
  `createIntent` performs a real `POST /v1/payment_intents` — the buyer gets a LIVE client
  secret, `metadata[order_id]` carries the settlement key the webhook is matched on, and the
  checkout `Idempotency-Key` travels as Stripe's native one — and refunds become available.
  **Without it**, `createIntent` mints an OFFLINE deterministic handle (`pi_<orderId>` plus a
  fake client secret that no Stripe.js/Elements can ever pay) and the service logs a loud
  boot warning (`STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is NOT …`). That stays a
  warning, never a boot failure: staging and e2e run offline on purpose. A live-intent
  failure (Stripe down or rejecting) answers **502 `PAYMENT_INTENT_FAILED`**; the `pending`
  order row is kept deliberately — retrying with the same `Idempotency-Key` re-issues the
  *same* PaymentIntent, and `expire-orders` sweeps the order at the checkout TTL (releasing
  stock and any coupon use) if it never gets paid.

> **Live Stripe is TWO-DECIMAL currencies only.** Urumi stores money as integer minor units
> at hundredths scale everywhere, while Stripe expects `amount` in each currency's own
> smallest unit. For **zero-decimal** currencies (JPY, KRW, CLP, VND, BIF, DJF, GNF, KMF,
> MGA, PYG, RWF, UGX, VUV, XAF, XOF, XPF) that would charge the buyer **100×**, and for
> **three-decimal** ones (BHD, JOD, KWD, OMR, TND) it is the mirror error — so the live
> `createIntent` **refuses them before any network call**, answering 502
> `PAYMENT_INTENT_FAILED` (provider code `unsupported_currency` in the service log). Do not
> price a catalog in those currencies against a secret-key-configured deployment; the
> offline (no-secret-key) path is unaffected. Lifting this needs an exponent-aware money
> boundary, not an adapter tweak — the deny-list is `STRIPE_UNSUPPORTED_CURRENCIES` in
> `packages/payments-stripe/src/index.ts`.

> **x402 is fail-closed.** The only facilitator the service can currently wire is the
> **offline TEST facilitator** — a shared-secret HMAC check, not real x402 verification:
> any holder of `X402_FACILITATOR_SECRET` can forge a settling proof. Setting `X402_PAYTO`
> + `X402_FACILITATOR_SECRET` without the explicit `X402_ALLOW_TEST_FACILITATOR=true`
> opt-in **refuses to start** (a thrown error, never a silently-armed gateway), and the
> opt-in path warns loudly at startup. **Never set `X402_ALLOW_TEST_FACILITATOR=true` in
> production.** `X402_ACCEPTS` (optional, default `eip155:8453`) is the comma-separated
> accepted-networks list. Fixed end-state: a real facilitator client behind the
> `X402PaymentGateway` seam retires the opt-in gate and this box.

- **Email** — with `EMAIL_API_URL` unset the service uses the console sender: emails are
  **logged, not delivered** (visible in `wrangler tail` on Workers). Set `EMAIL_API_URL` +
  `EMAIL_API_KEY` + `EMAIL_FROM` for a real HTTP email provider, and `STOREFRONT_BASE_URL`
  so magic-link login emails carry a clickable URL (unset, they carry raw challenge
  credentials only).

## 5. Environment variable reference

Node bin and Worker read the **same names by design** — on Workers, plain vars go in
`vars`, secrets via `wrangler secret put`. "Entry" says who reads it.

| Variable | Entry | Default | What it does |
|---|---|---|---|
| `PG_CONNECTION_STRING` | Node only | — (boot throws) | Postgres DSN. Workers use the `HYPERDRIVE` binding instead — no DSN secret on Workers |
| `PORT` | Node only | `3000` | listen port (no bind-address knob — issue #43, §2.0) |
| `CART_HOLD_TTL_MS` | both | `900000` (15 min) | cart-hold **and** checkout TTL (one knob drives both); must parse as a positive number or boot/first-request fails |
| `HOLD_SWEEP_INTERVAL_MS` | Node only | `60000` | self-interval hold-sweep cadence |
| `EMAIL_DISPATCH_INTERVAL_MS` | Node only | `30000` | self-interval outbox-drain + challenge-prune cadence |
| `INTERNAL_API_TOKEN` | both | unset ⇒ operational surface 503s | §4 |
| `SERVICE_API_TOKEN` | both | unset ⇒ write surface **open** | §4 — provision on both sides (kv first) to close the gate |
| `STRIPE_WEBHOOK_SECRET` | both | unset ⇒ webhook 503, gateway unwired | §4 |
| `STRIPE_SECRET_KEY` | both | unset ⇒ **offline, unpayable** intents + no refunds (boot warns) | §4 — set it to create real PaymentIntents |
| `X402_PAYTO` | both | unset ⇒ x402 not configured | x402 pay-to address |
| `X402_FACILITATOR_SECRET` | both | unset ⇒ x402 not configured | test-facilitator HMAC secret (§4) |
| `X402_ACCEPTS` | both | `eip155:8453` | comma-separated x402 accepted networks |
| `X402_ALLOW_TEST_FACILITATOR` | both | unset ⇒ x402 config **refuses to start** | must be `true` to arm the TEST facilitator — never in production (§4) |
| `EMAIL_API_URL` | both | unset ⇒ console sender (log-only) | HTTP email API endpoint |
| `EMAIL_API_KEY` | both | unset | email API key |
| `EMAIL_FROM` | both | `no-reply@urumi.local` | From address |
| `STOREFRONT_BASE_URL` | both | unset ⇒ magic-link emails carry raw credentials, no URL | absolute base URL for login links |
| `COMMERCE_SERVICE_URL` | site, **build time** | placeholder ⇒ inert egress | baked into bundle + `allowedHosts` (§1) |
| `EMDASH_ENCRYPTION_KEY` | site, secret | — | §4 |

## 6. Operations & scaling

**Cron cadences.** On Workers the service's `*/15` cron is the janitor for four jobs: the
hold sweep (a bound on dead-hold lifetime — hold expiry is also lazy-on-read, so correctness
never depends on the timer), **order expiry** (clock-driven, so this cron *is* its
production driver on Workers), the order-email outbox drain, and the login-challenge prune.
The Node bin runs the email/prune pair every 30s; at the Worker's 15-minute tick an
order-status email can lag up to one tick — `POST /internal/dispatch-emails` is the
on-demand lever. The cadence stays `*/15` so a serverless Postgres origin can autosuspend
between ticks (§3.0). The **site's** cron is `* * * * *` — EmDash's scheduled publishing is
minute-granular and the free-plan D1 limits are unaffected; it may be relaxed (e.g.
`*/5 * * * *`) if cron noise ever matters more than publish latency.

**Scaling.** The app tier is stateless and scales horizontally: the Worker builds
per-event `pg` pools (`max: 5` — Hyperdrive owns the real origin pool) and N Node replicas
behind a load balancer work the same way; the sweeps are idempotent (guarded flips,
atomic claims), so N replicas racing the same sweep never double-release or double-send;
every command carries an idempotency key the store enforces once-only. The arbiter of all
stock and money truth is the **single Postgres** — that is the scaling ceiling, and scaling
reads/writes past it is a database decision, not an app-tier one.

## 7. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Storefront shows content-only catalog with a notice; service never logs the request | Worker→workers.dev subrequests stubbed 404 — the site must ship `global_fetch_strictly_public` (§3.5), or put a custom domain on the service (#32) |
| Every SSR request hangs, nothing in logs | `global_fetch_strictly_public` + D1 `session` both on — pairing invariant violated (§3.5); turn `session` off |
| Storefront calls all 401 (cart writes, and PDP/PLP + login) | `SERVICE_API_TOKEN` set on the service but `settings:serviceToken` not provisioned in plugin kv — set it via the Settings form (§4) |
| `/internal/*`, `/admin/*`, `/reports/*`, `/settings` answer 503 — **reads too**, e.g. `GET /admin/tax/classes`, `GET /settings`, and the plugin's Shipping/Tax/Coupons/Settings screens showing "unavailable" | `INTERNAL_API_TOKEN` unset — set it and send `X-Internal-Token` (§4). Since ADR-0010 the admin **read** surface is gated too, so a deployment that never set this now 503s where it previously answered 200 |
| `/products` empty right after deploy | Healthy (§1) — sample content lands via the wizard checkbox, not first boot |
| Stale reads after writes (Shape B) | Hyperdrive query caching left on — recreate the config with `--caching-disabled` (§3.1) |
| `POST /webhooks/stripe` answers 503 | `STRIPE_WEBHOOK_SECRET` unset (§4) |
| Node bin exits: `PG_CONNECTION_STRING is required` | Set the DSN (§2.2) |
| Worker 500s: `Missing Hyperdrive connection string` | `hyperdrive` binding absent or misconfigured — check the binding name and id in the config you deployed with (§3.1) |
| Service refuses to start: `x402 is configured … refusing to start` | Fail-closed x402 gate — remove the x402 vars or (non-production only) opt in (§4) |
| Site deploy went out but still calls the placeholder service host | Deploy doesn't rebuild — rerun the §3.2 build with `COMMERCE_SERVICE_URL`, then redeploy |
