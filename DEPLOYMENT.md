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

> **In active development — pre-1.0.** The core buy flow — catalog, cart and card checkout —
> works today, but APIs, storage document shapes, settings and admin screens may still change
> between releases. This guide is the self-deploy path; a one-click / hosted Cloudflare
> Workers deployment is coming soon.

> **Status honesty.** The commerce layer is feature-complete: catalog, inventory, cart,
> checkout, orders, customers with magic-link auth, Stripe payments, tax,
> shipping, discounts, entitlements, reporting, and settings (the magic-link email needs an
> EmDash email provider and a sign-in page URL, §3 Email). The reference **storefront** covers
> catalog, cart and **card checkout**: `/checkout`, the Stripe pay page (`/checkout/pay`) and
> the order confirmation page (`/orders/<orderId>`) are built (ADR-0012), and so are the
> customer account pages (`/account/login`, `/account/verify`, `/account/orders`). Paid
> digital downloads are built too (issue #376): the merchant attaches a file to a digital
> product in the admin, and a buyer downloads it from the order page. Deploying today gives you a browsable
> catalog, carts with real inventory holds, magic-link customer accounts, digital downloads,
> and a Stripe card purchase end-to-end once Stripe is configured (§3).

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
  `EMDASH_ENCRYPTION_KEY` and `OTTA_WH_TOKEN`. Every payment **credential** is
  provisioned by the operator in the admin console's **Store settings** page (General tab) and held in
  **write-only plugin `kv`** under `settings:*` — persisted only on a non-empty submit,
  never rendered back into a block, read through a fail-closed reader. The Stripe secret
  key, the Stripe webhook signing secret and the webhook edge token are **encrypted at
  rest** with `EMDASH_ENCRYPTION_KEY` (ADR-0037). Nothing
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

The site's single `* * * * *` cron touches only D1, within free limits — the commerce sweep
budgets itself to fit Workers Free's 50 D1 queries per invocation by default. On Workers Paid,
switch Store settings → General → Checkout & holds → "Background work per minute" to the Paid preset, or
expired holds and queued emails drain at the Free pace (§5).

### 2.1 The site Worker

1. **Create the content resources** (from `sites/staging`):

   ```bash
   wrangler whoami                                # confirm the right account
   wrangler d1 create YOUR-D1-DATABASE-NAME       # prints the database_id to paste in
   wrangler r2 bucket create your-media-bucket
   wrangler r2 bucket create your-downloads-bucket  # PRIVATE: paid digital downloads
   ```

   > **Never make the downloads bucket public.** It holds the files buyers pay for. The
   > site Worker is its only reader, through the `DOWNLOADS` binding, and it re-checks the
   > buyer's entitlement on every download (issue #376). So:
   > - **never enable its Public Development URL** (r2.dev): in the dashboard, the bucket's
   >   Settings → "Public Development URL"; on the command line,
   >   `wrangler r2 bucket dev-url enable`;
   > - **never connect a custom domain** to it: the bucket's Settings → "Custom Domains", or
   >   `wrangler r2 bucket domain add`;
   > - **never use the media bucket for it.** EmDash serves every key in the media bucket
   >   publicly at `/_emdash/api/media/file/<key>`, so a paid file there is readable by
   >   anyone who learns its key, including a buyer whose purchase was refunded. The build
   >   fails if `DOWNLOADS` and `MEDIA` name the same bucket, and the site refuses media keys
   >   under `dl/`, but neither can see a bucket's public-access settings.
   >
   > Check with `wrangler r2 bucket dev-url get your-downloads-bucket` (it should say
   > disabled) and `wrangler r2 bucket domain list your-downloads-bucket` (it should list
   > none). An existing deployment that leaves `DOWNLOADS` out of its config still builds:
   > downloads are then off, the order pages show no Download link, and the download URL
   > answers 404.
   >
   > **Attaching a file.** The merchant uploads it in the product editor: a Digital product's
   > **Download file** card sends the file to the site's `POST /otta-admin/downloads/<productId>`
   > (store admins only — the `plugins:manage` role), which stores it in this bucket under a
   > fresh `dl/<productId>/<id>` key and hands the card a descriptor that it saves on the
   > product ([ADR-0029](./adr/0029-console-uploads-download-files-to-a-site-endpoint.md)).
   > Files can be at most **100 MB** (Cloudflare's request limit on the Free and Pro plans).
   > Without the binding, an upload is refused with a sentence saying downloads are not set
   > up on this store (the card shows it once the merchant tries). Saving the file checks that
   > its object is in this bucket at the uploaded size, and refuses it otherwise. The reference
   > site's middleware makes this check, on whatever HTTP method the save arrives with, so on this
   > site a save cannot point buyers at a missing file. A different site hosting the plugin needs
   > the same check: the plugin cannot see the bucket.
   >
   > **Refunds the order's state doesn't show yet keep the download open.** A buyer loses access
   > when the order is refunded or cancelled in Otta. Money returned in a way the order does not
   > show yet does not close access by itself:
   > - **A refund made in the Stripe dashboard:** start the same refund in Money → Refunds
   >   (Otta checks with Stripe, issues nothing and flags the order), then use **Mark refunded**.
   > - **A chargeback or dispute:** Otta does not act on disputes, and Mark refunded is refused
   >   while the payment shows as captured. Close access by hand: the order's Fulfilment tab →
   >   Downloads → **Revoke download access** (offered on a paid order only). It moves no money,
   >   changes no order state and can't be undone; History records who did it, and the order
   >   then shows "Download access was revoked".
   > - **A cancellation whose refund timed out** ("refund status unknown"): the order stays
   >   uncancelled until you confirm that refund in Money → Refunds, which finishes the
   >   cancellation and closes access.
   >
   > A partial refund keeps access by design.
   >
   > **A file is replaced, never removed.** Past buyers keep access, so a product with a
   > download file stays Digital: the editor disables the Physical choice and says why.
   >
   > **Unused files are cleared after a week.** Replacing a file uploads a new object and points
   > the product at it; every buyer's link serves the new file from then on. The old object
   > stays for now, and so does an upload whose save never happened (a closed tab). Once an
   > hour the site's cron deletes such objects (at most 100 a run) once they are over a week old
   > and the product's current file is too, so no download in progress loses its file. It never
   > deletes the file a product names, a key the upload endpoint did not mint, or anything
   > under a product the store cannot find; it reads each product through the plugin and stops
   > for the hour if that read fails. So that a file it may delete can never be attached,
   > saving an upload more than six days old is refused: upload the file again. Each object's
   > metadata records the product, the original filename and who uploaded it. Files of a
   > product the store no longer has are never reclaimed by the sweep; remove those by hand
   > (`wrangler r2 object delete your-downloads-bucket/<key> --remote`).

2. **Fill in the local config.** Copy `sites/staging/wrangler.jsonc` (also a template) to
   `wrangler.local.jsonc` (gitignored) and set your Worker `name` (over `my-otta-store`),
   D1 `database_name`/`database_id`, and the two R2 `bucket_name`s (`MEDIA` and
   `DOWNLOADS`, which must differ). Do not add the
   `global_fetch_strictly_public` compatibility flag: D1 sessions are on, and the flag
   hangs them — §2.4 explains both.

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
   there is no service URL to bake in, and no egress URL either (§4):

   ```bash
   pnpm --filter @urumi.ai/otta-site-staging build
   ```

   The build does not type-check. If you changed code, run `pnpm typecheck` first.

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
   it in that product's **Pricing & stock** cards (the CMS holds no commercial data);
   add-to-cart sets the `otta_cart` cookie and creates a hold. The three sample products
   are content-only until you price them — the seed fires no content hooks, so either
   price them in each product's Pricing & stock cards or run `sites/staging/scripts/seed-demo-commerce.ts`
   against the SITE. It drives the site's own admin API — the route the Pricing & stock
   cards use — so it needs only the site URL and a token that can read the CMS
   and call that route:

   ```bash
   SITE_URL=https://<your-site-worker>.workers.dev \
   EMDASH_TOKEN=<an admin API token> \
     pnpm dlx tsx@4 sites/staging/scripts/seed-demo-commerce.ts
   ```

   The script is safe to re-run: it reads each product first and skips any that already
   has a SKU, so it never overwrites a price set in the Pricing & stock cards.

   **A store created before 2026-10-01** has no `pricing` field on its products collection, and
   the Pricing & stock cards draw on that field. Add it once with the script below — **not** in
   Admin › Content Types, which in EmDash 1.0.1 cannot attach the cards to a field: a JSON field
   added there shows EmDash's raw JSON box instead, where commerce data must never be typed.
   The script places the field after Images, re-binds a hand-made one, and is safe to re-run:

   ```bash
   SITE_URL=https://<your-site-worker>.workers.dev \
   EMDASH_TOKEN=<an admin API token> \
     pnpm dlx tsx@4 sites/staging/scripts/add-pricing-field.ts
   ```

   The field holds no data; new stores get it from the seed. If a product editor ever shows a
   raw JSON box labelled "Pricing & stock" instead of the cards, the console's admin module did
   not load (or the field lost its widget): leave the box empty and re-run the script.
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

### 2.4 D1 sessions (`"primary-first"`) and `global_fetch_strictly_public`

> The site's `wrangler.jsonc` does **not** carry the `global_fetch_strictly_public`
> compatibility flag (issue #375). One consequence of running without it: a fetch to a
> hostname on the site's **own zone** is routed to that zone's origin, not back through
> Cloudflare, so never add an egress host on the site's own zone.
>
> D1 `session` in `sites/staging/src/emdash-options.ts` is **`"primary-first"`**: every
> request EmDash has not authenticated — every shopper — and every write and cron run starts
> on the primary, so a shopper's redirect after a write (placing an order, signing in,
> resuming a payment) always reads what it just wrote, even with read replicas on. It is
> **not** `"auto"`: that mode gives read-your-writes (a bookmark cookie) only to requests
> EmDash authenticates and starts every other request on any replica, so a lagging replica
> would show a just-placed order as not found or bounce a just-signed-in buyer to the login
> page. `"auto"` needs a shopper-side bookmark first. EmDash-authenticated requests resume
> from their `__em_d1_bookmark` cookie. That cookie is never set on an **anonymous**
> storefront response, so shopper pages stay cacheable as before; an admin browsing the
> storefront while signed in does get one, which is harmless. Read replication itself is switched on separately, on the D1 database
> (dashboard or REST API); until it is, every query goes to the primary anyway.
>
> **Before you switch read replication on, check it on a replicated staging D1 (issue #490).**
> `pnpm test:d1` (`session-storage.d1.spec.ts`) proves the storage paths run over a D1
> session handle, but not replica lag: miniflare has no replicas, so it cannot return a
> stale read. Staging has to show that, and each step below has to be able to fail:
>
> 1. Enable read replication on the staging D1 only. Run the staging Worker from a region
>    away from the primary, and confirm in `wrangler tail` that storefront GETs report
>    `served_by_primary: false`. If every query still says `true`, no replica is serving and
>    the steps below prove nothing.
> 2. Shopper requests start on the primary (`primary-first`; shoppers carry no bookmark).
>    Repeat each flow 20 times; any one failure fails the check:
>    - place an order, then load `/checkout/pay`: it must find the order (a 404 fails);
>    - sign in, then load `/account/orders`: it must stay signed in (a bounce to `/login`
>      fails).
> 3. Signed-in EmDash requests resume from the `__em_d1_bookmark` cookie. Repeat 20 times:
>    - change a product's price in the admin, then reload: the new price must show;
>    - let a Stripe test webhook mark an order paid, then load the admin order list: the
>      order must show as paid on the first load.
>
> To roll back, disable read replication on the D1 (dashboard or REST API). Every query
> then goes to the primary again; there is nothing to migrate.
>
> **The old pairing invariant is moot, but its rule stands:** the flag blocks the request the
> D1 Sessions API makes to route queries (emdash issue #1273). With EmDash 1.0.1 the symptom
> is a **~5 s stall on the first session query of every new isolate**; EmDash's hang guard
> then turns sessions off for that isolate, silently, and a **write caught in flight**
> (placing an order, a cart change, the Stripe webhook settle) **may be rejected** with a
> 500 rather than re-run. Nothing fails at deploy time. So the flag must never come back
> while a session mode is set. Pinned by `sites/staging/test/wrangler-config.test.ts` (flag
> absent, template hygiene) and `sites/staging/test/site-config.test.ts` (`"primary-first"`;
> never flag + session together, `sites/staging/src/lib/wrangler-pairing.ts`).
>
> **Your own `wrangler.local.jsonc` is not checked.** If you made it by copying the template
> before issue #375 (§2.1 step 2), it may still list the flag: delete
> `"global_fetch_strictly_public"` from its `compatibility_flags`, leaving `["nodejs_compat"]`.
> (A build-time guard used to refuse that file; it was removed in issue #455.)
>
> A **custom domain** on the site (issue #32) is what unlocks zone-level WAF rules.

### 2.5 Per-IP rate limits (anonymous writes and sign-in)

The storefront's writes are anonymous by design: anyone can create a cart, change it, place an
order, or ask for a sign-in link. The site limits them per client IP with two Cloudflare
[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
bindings, checked in its middleware (`sites/staging/src/lib/rate-limit.ts`, issues #91 and #29).
**Set this up before you open customer sign-in to real customers:**
[ADR-0004](./adr/0004-customer-auth-mechanism.md) makes per-IP limiting on the sign-in request a
prerequisite, because the per-address throttle can be used to lock a customer out.

Add the bindings to your `wrangler.local.jsonc` (the tracked template carries them commented
out), then build and deploy as in §2.1:

```jsonc
"ratelimits": [
	{ "name": "RATE_LIMIT_AUTH", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } },
	{ "name": "RATE_LIMIT_WRITES", "namespace_id": "1002", "simple": { "limit": 60, "period": 60 } },
],
```

Each `namespace_id` is a string holding a positive integer, unique within your Cloudflare
account. Two Workers that share one share its counters. `period` must be `10` or `60` seconds.
The site sends that period as `Retry-After` from its own table (`RETRY_AFTER_SECONDS` in
`sites/staging/src/lib/rate-limit.ts`), so a changed `period` needs that constant changed too;
a changed `limit` needs nothing. Check Cloudflare's current plan availability for the binding
before relying on it.

| Binding | Limit | Routes (POST on the site, plus GET on `/checkout/resume`; any method but OPTIONS on the plugin mount) |
|---|---|---|
| `RATE_LIMIT_AUTH` | 10 / min | `/account/login/request`, `/account/verify/confirm`, `/checkout/resume`; plugin `storefront/account/login/request`, `storefront/account/login/verify`, `storefront/order/resume` |
| `RATE_LIMIT_WRITES` | 60 / min | `/cart/add`, `/cart/update`, `/cart/remove`, `/cart/switch-currency`, `/checkout/place`, `/checkout/new-cart`; plugin `storefront/cart/create`, `storefront/cart/lines/{add,update,remove}`, `storefront/checkout/place`, `storefront/order/abandon` |

The plugin routes are at `/_emdash/api/plugins/otta/<route>`. They are counted on GET too,
because EmDash's plugin dispatcher runs a route for a GET as well, taking its input from the
query string. `/checkout/resume` counts on GET as well, because its GET (the order page's
"Complete payment" link) runs the same resume step.

The key is the route class plus `CF-Connecting-IP`. An IPv6 client is keyed by its /64, and an
IPv6 spelling of an IPv4 address (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`) by
that IPv4 address. If the zone uses **Pseudo IPv4: Overwrite headers**, `CF-Connecting-IP`
holds a 240.0.0.0/4 stand-in for an IPv6 client; the site then keys on `CF-Connecting-IPv6`
instead (and reads that header only then, so a client cannot choose its own key).

Over the limit, the request is answered **429** with `Retry-After: 60`: EmDash's JSON error
envelope (`{"success":false,"error":{"code":"RATE_LIMITED",…}}`) on the plugin mount, and a
short HTML page with a "Go back" link on the site's form endpoints. The site's own pages call
the plugin in-process, not over HTTP, so a shopper's add-to-cart counts once.

**Check it works.** In a scratch copy of your config, set `RATE_LIMIT_WRITES`'s `limit` to `1`,
run `wrangler dev`, and POST to `/cart/add` twice within a minute (for example
`curl -si -X POST -d sku=x http://localhost:8787/cart/add` twice): the second answer is
`429 Too Many Requests` with `Retry-After: 60`. Without the binding both pass, and the log shows
`rate limiting is OFF for writes routes`. Put the real limit back before you deploy.

**Without the bindings the site fails open:** every request passes, and the Worker logs
`rate limiting is OFF for <class> routes` once per isolate. It also passes when a request has
no `CF-Connecting-IP`, or when the binding call fails (logged at most once every five minutes,
so an ongoing failure stays visible). Cloudflare counts per location and only
approximately, so treat the numbers as a ceiling on abuse, not an exact quota.

**What the per-IP key does and does not cover:**

- **IPv6 allocations are often larger than a /64.** Many ISPs hand a subscriber a /56 or a
  /48, which holds 256 or 65,536 /64s. A client with such a block can rotate through /64 keys.
  6to4 addresses (`2002::/16`) are the same: each embeds an IPv4 address and carries a whole
  /48 behind it. The limit still raises the cost of a flood, but treat it as a speed bump
  against a determined attacker with IPv6, not a wall. A WAF rule (below) or Cloudflare's bot
  products are the next layer.
- **Many customers can share one address.** Mobile carriers' CGNAT, offices, schools and
  public Wi-Fi put many people behind one IPv4 address. They then share one budget, and the
  auth class is the tight one: ten sign-in requests a minute across the whole network. If real
  customers report "Too many requests" on sign-in, raise `RATE_LIMIT_AUTH`'s `limit` in
  `wrangler.local.jsonc` (for example to 30) and rebuild and deploy (§2.1 steps 4 and 5). Raise
  `RATE_LIMIT_WRITES` the same way if busy shared networks hit the cart limit. The code needs no
  change: the binding enforces the number, and the site only reads `Retry-After` from its own
  table.

**Deliberately not limited.** These public routes are left out on purpose:

- **Reads** (plugin `storefront/product`, `storefront/list`, `storefront/cart/read`,
  `storefront/checkout/summary`, `storefront/order`, `storefront/payment-config`,
  `storefront/shopper-state`, and the site's GET pages). They create nothing and send no mail.
  Flooding them costs the attacker as much as the store, and a limit there would throttle
  crawlers and every page view behind a shared address. Cloudflare's own DDoS protection covers
  volume.
- **Session-holder routes** (plugin `storefront/account/orders`, `account/order`,
  `account/addresses`, `account/me`, `account/logout`, and the site's `/account/logout`). They
  answer only for a valid session token, so there is nothing to guess beyond the token itself.
- **`entitlements/download`** and the site's download endpoint. Each download re-checks the
  buyer's entitlement, and a buyer may fetch a file several times.
- **The Stripe webhook** (`/webhooks/stripe` and plugin `webhooks/stripe/settle`). Stripe's
  signature authenticates it, and refusing a genuine delivery would leave a paid order
  unsettled.
- **The admin and `/otta-admin/*`.** EmDash's own authentication guards them.

**Optional: a WAF rule as well.** With a custom domain on a zone you control (issue #32), a
Cloudflare WAF rate-limiting rule stops a flood before it runs the Worker at all, which the
binding cannot (a refused request is still a Worker invocation). For example, Security → WAF →
Rate limiting rules: match `http.request.method eq "POST" and (http.request.uri.path in
{"/account/login/request" "/_emdash/api/plugins/otta/storefront/account/login/request"})`,
counting by IP, 10 requests per minute, action Block. Check your plan first: on the **Free**
plan, rate-limiting rules allow only a 10-second counting period (and few rules), so the
equivalent there is about 2 requests per 10 seconds. Longer periods and more counting options
need a paid plan. Keep the bindings too: they are versioned
with the code and cover every route listed above.

## 3. Secrets & tokens checklist

Two of these are **Worker secrets** on the site (`wrangler secret put`); the rest are
**plugin credentials** the operator types into the admin console's **Store settings** page (General tab), which
persists them to write-only plugin `kv` under `settings:*`. On Workers, **every `wrangler
secret put` below** needs `--config wrangler.local.jsonc`: without it, wrangler defaults to
the tracked template and uploads the secret to the placeholder-named Worker, not yours. In
order of appearance in a deployment's life:

| Secret | Where it lives | Required? | When to set |
|---|---|---|---|
| `EMDASH_ENCRYPTION_KEY` | Worker secret | yes | before the site's first boot |
| `OTTA_WH_TOKEN` | Worker secret **+** admin Settings (same value, both halves) | optional outer gate on the settle routes | with the Stripe webhook secret |
| Stripe webhook signing secret | admin Settings (`settings:stripeWebhookSecret`) | for Stripe payments — **together with the secret key** (see below) | before enabling Stripe |
| Stripe secret key | admin Settings (`settings:stripeSecretKey`) | for Stripe payments — **together with the webhook secret** (see below) | before enabling Stripe |
| Email provider (from-address, SPF, DKIM, its own key) | an **EmDash email provider plugin**, selected in EmDash Settings > Email — not otta | optional | when wiring real email |

> **Never put a secret in the build environment.** Set every secret only as a Worker secret
> (`wrangler secret put`) or in admin Settings. Do not export it in the shell or CI job that
> runs `pnpm build`, and keep it out of `sites/staging/.env`. Astro reads the build's whole
> environment, `.env` files included. It writes the value of any variable whose **name**
> appears in a server module that uses `import.meta.env`, or that a module reads as
> `import.meta.env.KEY`, into the worker bundle in plain text (issue #584). emdash's OAuth
> routes name `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` and
> their `EMDASH_OAUTH_*` forms, so a build that had one of those set shipped it. The build
> guards against this (`sites/staging/src/lib/build-path-scrub.ts`):
>
> - it **removes** secrets from its own `process.env` before Astro reads it, and warns with
>   their names (never the values). A secret is any variable on the list there (emdash's
>   `EMDASH_AUTH_SECRET`, `AUTH_SECRET`, `EMDASH_ENCRYPTION_KEY`, `EMDASH_PREVIEW_SECRET`,
>   `EMDASH_IP_SALT`, the OAuth and Turnstile secrets, storage and database credentials;
>   Otta's `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `OTTA_WH_TOKEN`; deploy tokens such
>   as `CLOUDFLARE_API_TOKEN`), any variable whose name contains `SECRET`, `TOKEN`,
>   `PASSWORD`, `SALT`, `CREDENTIAL`, `API_KEY`, `ACCESS_KEY` or `PRIVATE_KEY`, and any that
>   ends in `_KEY`, `_PASS` or `_DSN`. `PUBLIC_*`, `*_SITE_KEY`, `*_PUBLISHABLE_KEY` and
>   `*_PUBLIC_KEY` are left alone. A build that needs Cloudflare remote bindings must
>   authenticate with `wrangler login`, not a `CLOUDFLARE_API_TOKEN` in the build env, because
>   the build drops that token;
> - it **deletes `dist/server/.dev.vars`**, the plaintext copy of your local `.dev.vars` (or
>   `.env`) that the Cloudflare Vite plugin writes there. `wrangler deploy` never uploads it,
>   but any copy of `dist/` would carry it. A built `dist/` run with `astro preview` therefore
>   has no local vars;
> - it **fails the build, and deletes `dist/server`**, if a secret's value (16 characters or
>   more) is in the bundle anyway, for example from a `.env` file, which the first step cannot
>   reach. It also searches `dist/client`, where prerendered pages land, and a hit there deletes
>   `dist/client` too. Remove the variable from the build environment and the `.env` file, then
>   build again.
>
> For `astro dev`, keep local secrets in `sites/staging/.dev.vars` (gitignored). The dev
> Worker reads it, and Astro never does, so nothing in it can reach a bundle. A
> `sites/staging/.dev.vars` also replaces the env that the e2e stack injects (its throwaway
> `EMDASH_ENCRYPTION_KEY` arrives through `CLOUDFLARE_INCLUDE_PROCESS_ENV`, which wrangler
> ignores when `.dev.vars` exists), so move it aside, or put the e2e key in it, for
> `pnpm test:e2e`. A dev `.env`
> that holds only `EMDASH_ENCRYPTION_KEY` still builds: no server module names that key today,
> and the build fails if one ever does.
>
> The removal does not change the deployed site. Under `@astrojs/cloudflare`, emdash reads its
> env only from the Worker (`virtual:emdash/env` re-exports `env` from `cloudflare:workers`,
> which is always defined), so the build-time `import.meta.env` fallback was never used.
>
> **If you deployed a build that had one of these set**, treat the secret as exposed:
>
> 1. Rotate it at its provider (for an OAuth client secret: GitHub, Google or Microsoft;
>    for a Stripe key: the Stripe dashboard).
> 2. Put the new value in place: `wrangler secret put <NAME> --config wrangler.local.jsonc`
>    for a Worker secret, or admin Settings for a Stripe key.
> 3. Delete the old `dist/` and any copy of it (CI artifacts, caches, tarballs).
> 4. Remember that Cloudflare keeps earlier Worker versions, and their bundles hold the old
>    value in plain text. Rotation is what makes those copies harmless.

- **`EMDASH_ENCRYPTION_KEY`** — **required.** Generate with `npx emdash secrets generate`;
  never committed, never echoed into logs; **back it up in a password manager**. EmDash
  encrypts plugin settings declared `secret` with it (AES-GCM), and Otta declares three: the
  Stripe secret key, the Stripe webhook signing secret and the webhook edge token
  (`settings:otta-wh-token`) (ADR-0037). The site's Otta
  descriptor must keep its `settingsSchema` for that to happen. Other plugin settings, the
  email keys and order data are **not** encrypted with it.
  - **Enter these keys on Otta's Store settings page only.** Declaring them makes EmDash also show
    a Settings gear for the plugin under Plugins; its form stores whatever is typed, without
    Otta's checks. Otta checks every stored key's shape when it reads it: an empty or
    malformed value is never used (payments refuse, the webhook route answers 503) and
    Otta's Store settings page shows "saved, but not valid" until it is entered again there.
  - **Where it is read:** EmDash reads it from `process.env`. On Workers that is the Worker
    secret (`nodejs_compat` populates `process.env`). **Local development (`astro dev`):**
    put `EMDASH_ENCRYPTION_KEY=<key>` in `sites/staging/.dev.vars` or `sites/staging/.env`
    (both gitignored; generate a separate dev key). `.dev.vars` is the safer choice because
    Astro never reads it into a build (above). When it exists, the dev Worker reads it instead
    of `.env`. Exporting the key in the shell does **not** work: the dev Worker runs in
    workerd, which does not inherit the shell environment. The Playwright stack and CI's
    e2e job use a throwaway test key (`playwright.config.ts`).
  - **Missing:** saving any of those three keys fails, and a key already saved encrypted
    cannot be read. Payments then refuse as "not configured", the webhook route answers
    503 (Stripe retries it), and Settings shows the key as "saved, but cannot be read".
    Nothing falls back to an unencrypted copy.
  - **Lost:** the three keys cannot be recovered. Set a new key, then enter each key again in
    Settings (or remove it there).
  - **Rotating:** put the new key first and keep the old one after it, comma-separated
    (`EMDASH_ENCRYPTION_KEY=<new>,<old>`). New saves use the new key; both still decrypt.
    Keep the old key listed until all three keys have been entered again in Settings (they
    are write-only, so each must be copied again from Stripe or its provider), then drop
    it. Or delete the re-save marker (below) and redeploy: the first cron tick re-saves all
    three under the new key. Keep the old key listed until the log shows `payment keys
    re-saved through the settings layer` after that redeploy; then drop it and check that each
    key still reads "— set" in Settings (if one does not, list the old key again). A rotation
    alone never triggers the re-save.
  - **Deleting the re-save marker** makes the next new isolate re-save every stored key under
    the current key. It is one kv row, `state:paymentSecretsEncrypted`; deleting it loses
    nothing. Trusted mode (the default):
    `wrangler d1 execute YOUR-D1-DATABASE-NAME --remote --config wrangler.local.jsonc --command "DELETE FROM options WHERE name = 'plugin:otta:state:paymentSecretsEncrypted'"`.
    A sandboxed deployment keeps it in `_plugin_storage` instead:
    `... --command "DELETE FROM _plugin_storage WHERE plugin_id = 'otta' AND collection = '__kv' AND id = 'state:paymentSecretsEncrypted'"`.
    Then redeploy so a new isolate runs it.
  - **Upgrading a site that already has these keys saved:** the first cron tick after the
    deploy re-saves them encrypted (it needs the key set; until then it retries and
    logs one warning naming `EMDASH_ENCRYPTION_KEY`). It first reads every key and changes
    nothing if any cannot be read, so a wrong key cannot strand a working one — but if every
    key is still unencrypted, whichever key is set at that tick is the key they are saved
    under, so set the right one before deploying. It logs counts only (it never touches a
    leftover x402 key). Earlier backups and D1 Time Travel
    history still hold the earlier copies until they age out, so rotate a live Stripe key
    after the upgrade.
  - **After every deploy (required check):** open Otta's Store settings (General tab) and confirm that every
    payment secret you use (Stripe secret key, webhook signing secret, `OTTA_WH_TOKEN`) reads
    "— set". Re-enter any that says "saved, but not valid" or "saved, but cannot be read" —
    keys saved before 2026-10-02 or through EmDash's settings gear can read as not valid.
    While the webhook secret or `OTTA_WH_TOKEN` reads "saved, but not valid" or "saved, but
    cannot be read", every Stripe webhook answers 503 (an unset token is not checked).
  - **A custom site** must declare the schema (`PAYMENT_SECRET_SETTINGS_SCHEMA` in its
    descriptor `settingsSchema`) before upgrading. If it was added later, enter the three
    keys again in Settings, or delete the re-save marker (above) so the re-save runs again.
  - **Rolling back:** after the re-save, a build without the `settingsSchema` cannot
    read the three encrypted values, so Stripe payments and webhooks stop until you roll
    forward or enter the keys again. Nothing is lost. Keys entered while the old build runs
    are stored plain; after rolling forward, the first cron tick encrypts each of them again
    (the marker records which revisions it encrypted).
    Rolling back to the earlier (v1) encryption build re-saves every payment key once, and
    rolling forward again does it once more. Each re-save only rewrites the same value
    under the current key, so this is harmless.
  - **Rolling back past the tax-rate precision change (#475):** a build from before it
    knows only whole basis points. If it re-saves a rate such as 8.875% (stored as 888 bps
    plus a finer value), the finer value can be left behind and still match, so after you
    roll forward the new build charges 8.875% where the old build showed 8.88%. Re-saving the
    form unchanged keeps 8.875%. After rolling forward, check each rate shown with 3 or 4
    decimals in Tax rates and re-enter the rate you intend (for example 8.88).
  - **Rolling back past "Customer billing address" tax (#467):** if the store taxes by the
    customer's billing address, a build from before it rejects `basedOn: "billing"` and
    ignores all saved tax options, falling back to its never-saved rule. Nothing is deleted.
    Do not save Tax settings while the old build runs: a save replaces the stored options.
    After rolling forward, re-check Tax settings.
  - **A base address with no region now takes its country's zone (#594):** if the shop base
    address has no region and any zone lists a region of that country (for example a
    `GB-LND` zone beside `GB`), digital orders, and physical orders under "Based on shop base
    address", are now taxed at the country zone's rate instead of 0%, and prices shown
    including tax rise to match. Orders already placed keep their saved tax. Check Tax
    settings and the country zone's rates before deploying. Rolling back returns these
    stores to 0%; nothing stored changes.
  - **Rolling back past cart-scoped mutation keys (#609):** the old build can't see keys
    recorded as `cart:<cartId>:<key>`, so an add retried across the rollback may add a
    second time (the cart shows it) and shared-cached product pages hit `LINE_NOT_FOUND`
    again. Holds are still swept normally.
    The new build still reads a same-cart record written under the bare key by an older
    build (it logs `[domain] cart mutation resolved a pre-#609 bare key` when it does).
    That fallback can be dropped in any later release once every store has run this one
    longer than its hold TTL plus one sweep tick (7 days at the maximum `holdTtlMinutes`).

> **The Stripe webhook endpoint is public by design, and permanently site-owned.**
> Stripe delivers to `POST /webhooks/stripe` on the site (`sites/staging/src/pages/webhooks/stripe.ts`)
> — register **that** path in the Stripe dashboard, subscribed to exactly two events:
> `payment_intent.succeeded` and `payment_intent.payment_failed`. Those are the only events the
> settle route acts on — subscribe to nothing else. It is a transport shim: it reads the raw
> delivered bytes, never parses them, attaches the edge token, and dispatches the plugin's
> **public** `webhooks/stripe/settle` route in-process, replaying the status the plugin asks
> for so Stripe's retry behaviour stays correct. It holds no Stripe secret and verifies no
> signature itself.
>
> **The Stripe account may be shared with other software** (#595). A verified
> `payment_intent.*` event Otta did not create — no `metadata.order_id`, or one naming no order
> in this store — is answered 200 with reason `UNKNOWN_EVENT` or `ORDER_NOT_FOUND`, so the
> endpoint stays healthy; the second kind is logged at info level, naming the Stripe event id and
> the order id it carried, and records nothing (#616; `payment_events` rows that earlier releases
> left for such events are inert and need no cleanup). Foreign events also keep Settings' "last
> verified delivery" fresh: it proves the signing secret, not that Otta's own payments arrive.
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
> "nothing works" and never to "nothing is checked"); saved on the plugin side but
> unreadable (no usable `EMDASH_ENCRYPTION_KEY`), the route answers **503** and Stripe
> retries — the gate never opens because a read failed; set on the plugin side but unset on
> the site, **every delivery 401s** — that is the dangerous direction, and the reason the
> endpoint replays the 401 into Stripe's dashboard rather than swallowing it.

- **Stripe** — **set both the secret key and the webhook signing secret, or card checkout
  refuses every order.** The in-process commerce client builds the live Stripe gateway only
  when both are present (`packages/plugin/src/payments/stripe-wiring.ts`); with either one
  missing there is no `stripe` gateway at all, and every checkout fails before an order is
  created. That is deliberate, not a half-configured fallback: a gateway that could take a
  live payment but never verify its confirmation (or the reverse) would leave orders holding
  stock against a payment nothing can settle. Independently, until the webhook signing secret
  is set, the settle route answers `NOT_CONFIGURED`; it verifies deliveries with the
  **webhook secret only** (`packages/plugin/src/webhooks/stripe-settle-route.ts`), and uses the
  secret key, when set, only to refund a late payment (below). The pay
  page also needs the **publishable key**, entered in the same Settings group (issue #498;
  no rebuild) — see [`sites/staging/README.md`](./sites/staging/README.md).

  **Wallets (Apple Pay, Google Pay, Link).** The pay page already allows them (its
  `Permissions-Policy` opens `payment` to Stripe.js, issue #108), but Stripe offers a wallet
  only on a domain it knows: add every domain that serves `/checkout/pay` (the apex and each
  subdomain, e.g. `www.`) under Stripe Dashboard → Settings → Payment method domains, in live
  mode (live registrations carry over to sandboxes). Stripe does Apple's merchant validation
  itself, so no Apple Merchant ID and no `/.well-known/apple-developer-merchantid-domain-association`
  file is needed. A wallet button also needs HTTPS and a browser or device with that wallet
  set up; without a registered domain, buyers simply see the card form.

  **Upgrading a site built with `STRIPE_PUBLIC_KEY`:** remove that line from the environment
  and `sites/staging/.env` (a build or `astro dev` that still sets it refuses to start, saying
  so), restart, then paste the same `pk_…` key into Otta Settings → Payments & email →
  Stripe publishable key. Until it is entered, checkout says card payment isn't set up.

  With both secrets set, `createIntent` performs a real `POST /v1/payment_intents` over
  `ctx.http.fetch` (LIVE client secret, `metadata[order_id]` as the settlement key the
  webhook is matched on, the checkout `Idempotency-Key` travelling as Stripe's native one).
  Refunds from the admin console go to the same gateway (`POST /v1/refunds` over
  `ctx.http.fetch`, carrying the refund's idempotency key); with no gateway configured a
  refund is refused `REFUND_GATEWAY_UNAVAILABLE`. A live-intent failure (Stripe
  down or rejecting) refuses the checkout with `PAYMENT_INTENT_FAILED` and the `pending`
  order is kept deliberately — retrying with the same `Idempotency-Key` re-issues the *same*
  PaymentIntent, and the order-expiry sweep reaps it at the checkout TTL (releasing stock
  and any coupon use) if it never gets paid.

  **Late payments** ([ADR-0022](./adr/0022-declined-payment-keeps-order-pending.md), amended
  2026-10-02). A buyer can still pay after their order's hold lapsed and the order expired (a
  pay tab left open). Such a payment is now **refunded automatically** by the settle route,
  once, through `POST /v1/refunds` (key `late-payment-refund:<pi_…>`, each Stripe call bounded
  at 3 s): the order stays `expired`, its reconciliation flag is resolved with outcome
  `refunded` by `otta:auto-refund`, the buyer gets a "Payment refunded" email naming the
  refunded amount, and the order page says the payment was refunded. This needs the **secret
  key** on the settle path; without it the order is flagged for a manual refund as before, and
  the order page still shows the payment as captured rather than "nothing was charged". A
  transient Stripe error answers the webhook 503 (with `Retry-After`) so Stripe retries, and the
  cron's `late-refunds` leg keeps resuming it after Stripe stops (backing off 5 min → 15 min →
  hourly; best-effort — see §5); the flag reads `… automatic refund retrying` meanwhile. A
  retry that finds no Stripe gateway (a secret missing or unreadable) is treated the same way.
  After ~3 days of this it gives up — on every plan, Workers Free included — and flags the
  order `… needs checking (gave up retrying …) — verify in Stripe`, keeping the refund
  reservation as `unverified`. A cancelled order is refunded automatically only if its audit
  shows it was cancelled while unpaid.

  **Known gap — refunding by hand after a give-up.** Once a late refund is `unverified` (a
  give-up, or an ambiguous create), the order page keeps saying the payment "will be
  refunded" even after someone refunds it in the Stripe dashboard: nothing tells Otta the
  money went back. Resolve the reconciliation flag in the admin console so the order leaves
  the queue; the page copy follows the refunds ledger, and an admin "confirm refunded in the
  provider" action to finalize such a row is a planned follow-up.

  The window is also narrowed at the source. Checkout records the order's PaymentIntent, and
  from the order's hold deadline the cron's `cancel-intents` leg (right behind the outbox and
  the expiry legs) withdraws it once the order has expired or been cancelled unpaid:
  `POST /v1/payment_intents/{id}/cancel` over `ctx.http.fetch`, inside the tick's budget (see
  §5), each call given a fixed 1.5 s and started only with that much left (a tick running out
  never costs an attempt). The expiry itself never calls Stripe. A transient failure is retried
  by that leg on later ticks with backoff (5 attempts),
  then given up with one `[domain] gave up cancelling payment intent …` log line — harmless,
  since a payment on it is refunded as above. `/checkout/pay` also refuses (303 to the order
  page) an order that is no longer `pending` or whose hold has passed (the sweep expires such an
  order within about a minute). Orders placed before this change have no recorded intent and
  are not cancelled.

> **Live Stripe currencies.** Otta stores each amount in its currency's own minor unit (the
> currency table, `packages/domain/src/money/currencies.ts`) and sends it to Stripe unchanged,
> which is Stripe's `amount` (<https://docs.stripe.com/currencies>) for two- and zero-decimal
> currencies: USD, EUR, … and now JPY, KRW, VND and CLP; HUF and TWD charge as two-decimal.
> **Three-decimal currencies (BHD, JOD, KWD, OMR) are payable** (ADR-0035 amendment). Stripe
> takes their thousandths only in multiples of 10, so checkout rounds the order's **final
> total** half-up to 0.010 and shows the difference as a signed "Rounding" row (at most
> ±0.005); line prices, discounts, shipping and tax stay exact. The rounded total is what is
> charged, settled and reported. Refunds in these currencies are multiples of 0.010 (or the
> whole remaining amount); Otta refuses anything else, whatever asks. An amount that is not a multiple
> of 10 never reaches Stripe: the adapter refuses it before any network call (intent:
> `unsupported_amount`; refund: rejected). No other currency changes: no rounding row, no new
> field, identical Stripe requests. A code outside the table (ISK included)
> keeps its old treatment: typed in hundredths, Stripe's zero-/three-decimal codes refused,
> others passed through. The rule is `stripeRefusesCurrency` in
> `packages/payments-stripe/src/index.ts`.
>
> **Upgrading to the currency table — check before you deploy:**
>
> - **JPY, KRW, VND, CLP** amounts typed in the admin on an earlier version were stored **×100**
>   (a price typed `1500` was stored as 150000 and shown as ¥150,000). Live Stripe refused these
>   currencies, so such products were never purchasable; after the upgrade they are, at the
>   stored value. Check and re-enter every product price, shipping rate and fixed coupon in
>   those currencies first (the edit form now shows the stored figure, e.g. `150000`).
> - **HUF, IDR, COP, PKR** now display with ISO 4217's 2 decimals (ICU used 0). Amounts typed in
>   the admin were always stored in hundredths, so they now read correctly; amounts written in
>   whole units by another program (an import, a script) will read 100× smaller.
> - **Currency membership is enforced on the admin screens only** (a product's first price, new
>   shipping rates and coupons). Programmatic writes — the CMS product sync, the variant price
>   edit — still check only the code's shape.
> - **Percentage coupons**: a NEW cap or minimum spend now needs a currency (the coupon then
>   applies only to carts in it). Existing percentage coupons with a cap or minimum and no
>   currency keep working exactly as before.

> **Store currency.** Settings → Store → "Store currency" is the currency a **new** cart is
> created in (the storefront names none, so it is every shopper's cart). A store that never
> saves it keeps USD, exactly as before the setting existed — no migration. Every currency in
> the table can be the store currency (three-decimal ones included, with the rounding above);
> saving the select unchanged writes nothing. Changing it affects new carts
> only: carts already open keep their currency. **Decide it before pricing the catalogue.** A
> product's currency is fixed once it is priced, and a coupon's at creation, so products and
> coupons (fixed-amount, and percentage coupons with a cap or minimum spend) in another currency
> can't be bought or used in new carts (`CURRENCY_MISMATCH` at checkout), and they can't be
> moved to the new currency. Shipping rates are per currency, so add rates in the new one. A
> spent cart's replacement is in the currency the storefront names, else the saved store
> currency, else the spent cart's: **a theme that sends `currency` with `replacesCartId` keeps
> that currency; omit it to follow the store currency.** If the admin cannot read the store
> currency, it never guesses one into a saved value: the product picker, a new shipping rate and
> the coupon form ask you to choose. The admin's defaults follow it: an unpriced product's
> currency picker, the shipping rate filter and new-rate currency, and the coupon form's
> currency hint.

- **Email** — otta sends every email through the EmDash host's `ctx.email`
  ([ADR-0031](./adr/0031-email-through-emdash-host.md)). otta ships no email provider and
  holds no email credential: **install and select an EmDash email provider** — for example
  `cloudflareEmail({ from })` with a `send_email` binding, or your own small provider plugin
  (`docs/email-providers.md`). The from-address, SPF, DKIM and any API key belong to that
  provider. In `astro dev` EmDash's console provider is active and captured mail is readable
  at `/_emdash/api/dev/emails`.
  With **no provider** nothing is sent and nothing is lost: the order emails wait in the
  outbox **without spending attempts** (the cron sweep's `order-emails` leg reports `skipped`),
  the console says "no email provider" on every write that would have emailed, and Settings →
  "Payments & email" says so on one line. When a provider is selected the queue goes out —
  only email enqueued in the last **72 hours**; anything older is completed unsent, with no
  attempt spent, so buyers never get days-old status mail. On a sandboxed host, allow up
  to 5 minutes after selecting a provider: until the host's last "no provider" answer
  lapses, order emails stay queued and a sign-in request sends nothing. With a provider, a settled payment's **order confirmation goes
  out inline** from the settle route, and an admin's status move, fulfilment, cancel or refund
  sends its email inline from the console write (best-effort, a few seconds at most); the
  `order-emails` leg is the backstop that delivers anything those attempts missed, on its next
  run ([ADR-0005](./adr/0005-transactional-email-transport.md), 2026-10-02;
  [ADR-0026](./adr/0026-admin-order-actions-never-claim-money-that-did-not-move.md)).
  Delivery is **at-least-once**: `ctx.email` takes no idempotency key, so a send that timed
  out may have been delivered; each timeout counts as one of the row's five attempts, which
  bounds duplicates. **Magic-link login mail** goes out through the same pipeline, and only
  once Settings → "Sign-in page address" (`settings:loginLinkUrl`) holds the absolute URL of
  the storefront's `/account/verify` page — the emailed link points there and never at the
  request's origin. The save requires `https://` (plain `http://` only for `localhost`,
  `127.0.0.1` or `[::1]`), because the link carries a sign-in token, and that token now passes
  through the site's email hooks and provider, so treat them as trusted code.
  With no provider or no sign-in page URL, `requestLoginLink` answers the same generic
  success and logs once server-side. For the reference site, set it to
  `https://<your-site>/account/verify`. **Order emails link to the order page** through the
  same setting: its origin plus `/orders/<order id>`, the page a shopper is sent to after
  checkout (a bearer link — anyone holding it sees the order's public view, which carries no
  address or email). Two assumptions: the storefront is served from the **root** of that
  origin (a path on the sign-in page URL, such as `/shop/account/verify`, is dropped — the
  site's own links are root-absolute), and the URL is **https**. An `http:` URL is used only
  for `localhost`, `127.0.0.1` or `[::1]` (local development); any other http URL gives no
  order link, because a bearer link must not travel in clear text. Unset or invalid, order
  emails go out with no link; it is never taken from a request's `Host`. The sign-in email
  (and the sign-off of every order email) names the store from Settings → "Store display name"
  (`settings:storeDisplayName`), else the EmDash site name. The sign-in email states the
  link's real lifetime (15 minutes). Order emails list the order's own line snapshot, totals
  and ship-to, with money formatted as the storefront formats it.

> **Upgrading a store that used the built-in email senders.** The email API key, from-address,
> provider and region settings are gone, and a build-time email URL is ignored. Until an
> EmDash email provider is selected the store's email waits in the outbox. Configure the
> sender address and domain records in the provider instead.
>
> **Leftover email and x402 keys (delete them by hand).** Earlier builds stored the email
> API keys and the x402 settings in plugin kv as **plain text**. A one-time cron purge used to
> delete them; it was removed in issue #455, so a store that never ran it still holds them.
> Nothing reads them any more. The rows are:
>
> - email: `settings:emailApiKey`, `settings:emailApiKeyGen`, `settings:emailSmtp2goApiKey`,
>   `settings:emailSmtp2goApiKeyGen`;
> - x402: `settings:x402PayTo`, `settings:x402Accepts`, `settings:x402FacilitatorApiKey`,
>   `settings:x402FacilitatorApiKeyGen`, `settings:x402FacilitatorSecret`,
>   `settings:x402FacilitatorSecretGen`.
>
> First **revoke** the email API keys (Resend, SMTP2GO) and the x402 facilitator key at the
> provider: a key copied into a backup or D1 Time Travel stays live until revoked. Then delete
> the rows. Trusted mode (the default):
> `wrangler d1 execute YOUR-D1-DATABASE-NAME --remote --config wrangler.local.jsonc --command "DELETE FROM options WHERE name IN ('plugin:otta:settings:emailApiKey', 'plugin:otta:settings:emailApiKeyGen', 'plugin:otta:settings:emailSmtp2goApiKey', 'plugin:otta:settings:emailSmtp2goApiKeyGen', 'plugin:otta:settings:x402PayTo', 'plugin:otta:settings:x402Accepts', 'plugin:otta:settings:x402FacilitatorApiKey', 'plugin:otta:settings:x402FacilitatorApiKeyGen', 'plugin:otta:settings:x402FacilitatorSecret', 'plugin:otta:settings:x402FacilitatorSecretGen')"`.
> A sandboxed deployment may hold them in **either** table (the sandbox bridge routes `settings:`
> keys to `options`, while older bridge versions wrote them to `_plugin_storage`), so run the
> trusted-mode command above **and** this one:
> `... --command "DELETE FROM _plugin_storage WHERE plugin_id = 'otta' AND collection = '__kv' AND id IN ('settings:emailApiKey', 'settings:emailApiKeyGen', 'settings:emailSmtp2goApiKey', 'settings:emailSmtp2goApiKeyGen', 'settings:x402PayTo', 'settings:x402Accepts', 'settings:x402FacilitatorApiKey', 'settings:x402FacilitatorApiKeyGen', 'settings:x402FacilitatorSecret', 'settings:x402FacilitatorSecretGen')"`.
> Deleting a row that is not there is a no-op. The purges' own marker rows
> (`state:legacyEmailSecretsPurged`, `state:legacyX402SettingsPurged`) can be deleted the same
> way (they are not `settings:` keys, so sandboxed mode holds them in `_plugin_storage` only),
> or left: nothing reads them.

> **Leftover theme key (optional to delete).** Builds before issue #501 read the storefront theme
> from plugin kv `settings:storeTheme`. Otta now renders Tempered, its only theme, and nothing
> reads that key. It is not a secret, so leaving it is harmless. To delete it, run
> `wrangler d1 execute YOUR-D1-DATABASE-NAME --remote --config wrangler.local.jsonc --command "DELETE FROM options WHERE name = 'plugin:otta:settings:storeTheme'"`.
> A sandboxed deployment may also hold it in `_plugin_storage`:
> `... --command "DELETE FROM _plugin_storage WHERE plugin_id = 'otta' AND collection = '__kv' AND id = 'settings:storeTheme'"`.

## 4. Egress and `allowedHosts`

The plugin's only egress is `ctx.http.fetch`, gated by the descriptor's `allowedHosts`
allowlist (capability `network:request`). That allowlist is resolved at **build** time
(`packages/plugin/src/manifest.ts`, fed by `sites/staging/astro.config.ts`) and contains:

| Host | When |
|---|---|
| `api.stripe.com` | always |
| each host in `OTTA_EXTRA_ALLOWED_HOSTS` | when set (see below) |

No email host: email is not plugin egress. It goes through the host's `ctx.email`
(capability `email:send`, [ADR-0031](./adr/0031-email-through-emdash-host.md)), and the
EmDash email provider makes its own requests under its own allowlist. The only
deployment-supplied hosts are the operator extras below.

**Extra hosts: `OTTA_EXTRA_ALLOWED_HOSTS`.** A comma-separated list of hostnames to add to
the allowlist, read from the shell env, then `sites/staging/.env`, at
**build** time, e.g. `OTTA_EXTRA_ALLOWED_HOSTS=api.example.com,hooks.example.org`.
Nothing in Otta calls an extra host today: the plugin's own `ctx.http` calls go to
`api.stripe.com` only. The variable is for a deployment that adds code calling out through
the plugin's `ctx.http` (a fork or a later integration); leave it unset otherwise.
Entries are trimmed and lowercased, empty entries are dropped, duplicates collapse, and
the order is stable (Stripe, then extras as given). Each entry must be a public DNS hostname:
letters, digits and hyphens in dot-separated labels, with at least one dot. These **fail the
build** with an error naming every refused entry, so a typo is loud rather than silently
ungranted:

- a wildcard (`*`, `*.example.com`), or anything with a scheme, port, path or userinfo;
- an IPv4 literal (including hex forms such as `0x7f.0.0.1`) or an IPv6 literal;
- a single-label name (`localhost`, `intranet`);
- `localhost`, `local`, `internal`, `localdomain`, `home.arpa` and `lan`, and any name
  under them (`app.localhost`, `printer.local`, `metadata.google.internal`,
  `localhost.localdomain`, `nas.lan`);
- the wildcard-IP DNS services `nip.io`, `sslip.io` and `xip.io` and any name under them
  (`127.0.0.1.nip.io`), and the loopback names `localtest.me` and `lvh.me` and any name
  under them (`app.lvh.me` resolves to 127.0.0.1);
- any Stripe host other than `api.stripe.com`, above all `js.stripe.com`, which is loaded
  by the buyer's browser and is never plugin egress
  ([ADR-0012](./adr/0012-storefront-checkout-loads-stripe-elements-in-the-browser.md) §3).
  Listing `api.stripe.com` itself is a harmless no-op: it is always granted.

This is a **build-time sanity check against obvious mistakes, not SSRF protection**: any
public name can resolve to a private address. The capability stays `network:request`
(never `network:request:unrestricted`), and the runtime protection is EmDash's egress
check, which validates the resolved IP and blocks private, loopback and metadata addresses
whatever is listed here (the Worker deliberately runs without
`global_fetch_strictly_public`, §2.4). Listing a host means
trusting its DNS: EmDash validates the resolved IP and `fetch` then resolves again (a
DNS-rebinding window), and no platform flag backs this up. Allowlisted hosts, extras
included, also become allowed image sources in the plugin admin UI (EmDash behaviour for
`network:request`, already true for Stripe).

Stripe traffic goes through the same gate: `@urumi.ai/otta-payments-stripe` would default its
transport to `globalThis.fetch`, but the plugin constructs the live gateway with
`ctx.http.fetch` (`packages/plugin/src/payments/stripe-wiring.ts`) —
so the allowlist is the perimeter for `api.stripe.com` too. This
closes the caveat recorded in
[ADR-0020](./adr/0020-one-deployable-plugin-owns-commerce-truth.md) §2.

All of these are third-party hosts on the public internet. The Worker runs without
`global_fetch_strictly_public` (§2.4), so a URL on the site's **own** Cloudflare zone would
reach that zone's origin directly, skipping its Workers routes and security settings — keep
every allowlisted host (each `OTTA_EXTRA_ALLOWED_HOSTS` entry) off the site's zone.

Because it is build-time, adding a host means a rebuild and redeploy — a Settings edit
alone cannot widen it. That is deliberate: the allowlist is the perimeter, and an operator
editing a text field should not be able to move it.

## 5. Operations & scaling

**Cron.** The **site's** Cron Trigger is `* * * * *` — that drives the host's cron
*executor*, which claims due rows from its own task table. The **plugin** registers one task,
`commerce-sweeps`, also due every minute (`* * * * *`); the executor fires the plugin's `cron`
hook when it comes due. One task drives all sixteen sweep legs: they share a store composition
and a clock, and splitting them would only put sixteen rows in contention on the same documents. The
nine scan legs (`sku-transfers`, `order-sku-index`, `reporting-heal`, `coupon-orphans`,
`coupon-recount`, `stranded-holds`, `product-orphans`, `prune-carts`, `product-reconcile`) and the
sign-in challenge prune run at most every fifteen minutes inside that task (`product-reconcile`
checks every fifteen minutes but starts a new pass only once a day on Free, every six hours on
Paid — see below) (housekeeping: the scans read a page budget
of a collection per run); a scan cut short by the budget carries on next tick until its pass is done.
`prune-carts` (#39) deletes each cart that is active, has no lines, owes no hold work, was handed
off to no order, and has not been written for 30 days (the cart cookie's lifetime), together with
its `cart_create_keys` record. It pages the active carts at most once a day (its kv cursor,
`cron:sweep:cursor:prune-carts`, records when the last pass finished) and deletes at most 50 carts a
run. A run that reaches 50 is stamped and carries on at its next fifteen-minute cadence, not the
next tick (it gets no second run in the tick either), so a backlog drains at most 50 carts a quarter
hour. On the Workers Free preset it also deletes at most **300 carts a UTC day** (counted in the same
cursor); once that is reached each cadence run is one kv read until the UTC day turns.
A replay of a cart-create, rotation or re-currency key that hands out a fresh cookie also moves the
cart's `updatedAt`, so no cart cookie outlives its cart's window. A cart is never deleted while an
`order_keys` record names its storefront checkout (`checkout:<cartId>`); a headless client that
checks out under a key of its own is not recognised by that guard (such a cart is still kept by
having lines, or by being checked out). Known residuals, left as follow-ups:
- **Legacy key records.** Carts minted before this release do not record their create key, so
  their `cart_create_keys` record, if they have one, stays behind; a late replay of that key
  re-creates the cart empty, now recording its key, and a later pass prunes both.
- **`cart_mutation_index` locators.** A pruned cart's mutation-key locators are not deleted (one
  key can be shared by many carts through a cached page, so a safe delete costs a read and a
  guarded delete per key). A locator whose cart is gone already answers "no record".
- **Digital-only carts.** A cart holding only digital lines (no hold) is never empty, so it is
  never pruned, and no other sweep removes it.
- **Carts replaced by a currency switch.** `replaceStaleCurrencyCart` releases the old cart's holds
  but keeps its lines, so that cart is never empty and never pruned.

**Draining a backlog writes rows.** Each declared index is an expression index over the whole
shared `_plugin_storage` table (see "Deploying it builds one index" below), so every row carries an
entry in each of Otta's 46 indexes, plus the table row, its composite primary key's autoindex and the
host's own list index: deleting one row is about 49 rows written on D1, and a pruned cart deletes two
(the cart and its create-key record), about 98, call it 100 with other plugins' indexes. That is why a Free budget caps the
drain at 300 carts a day: about 30,000 rows written, under a third of D1 Free's 100,000 a day, which
once spent fails every write (add-to-cart and checkout included) until the UTC reset. A store with
N abandoned carts on its first day drains them in about N / 300 days on Free. On Workers Paid (a
budget above 50) there is no daily cap (D1 bills rows written per million and has no daily
ceiling). There a run deletes at most 50 carts and the leg's share stops it sooner (about 23 carts
at the Paid preset, 600), so an idle store drains about 70 carts a cadence — about 7,000 a day,
roughly 700,000 rows written; under sustained load a share-stopped run is not stamped and goes
again the next minute, so the drain can reach about 70 carts a minute (around 10 million rows a
day) until the backlog clears. These figures are derived from the index model, not measured on
D1. Overlapping ticks can pass the day's cap by at most one run (50 carts).

The cap keys off the **Background work per minute** setting, not the plan: 50 or less (every
budget Workers Free can run) counts as Free. So a Workers Paid store left at 50 or below is capped
at 300 carts a day too (choose the Paid preset to drain faster). A Free store that abandons more
than 300 empty carts a day never fully catches up; the rest wait their turn, untouched.
`product-reconcile` has a daily cap of its own on Free (200 repairs, about 30,000 rows written; see
"Rows written, and the daily repair cap" below), so the two together leave about 40,000 rows a day
for the store's traffic.

`stranded-holds` is a one-off repair (#631): it reads the inventory until one whole pass releases
nothing, then records `done` in its kv cursor (`cron:sweep:cursor:stranded-holds`) and costs one kv
read a run from then on. Deleting that key starts it again. `coupon-recount` sets a
coupon's use count back to the uses its redemptions hold when the two disagree (a release cut
between its delete and its decrement leaves it one high); it corrects only on a second look, at
least ten minutes after the first (each run rechecks the coupons it saw drift before walking on),
that finds the same drift with the counter untouched, and logs each correction by coupon code and
id. **Deploying it builds one index.** It counts a coupon's redemptions by state, through a new
`(couponId, state)` index on `coupon_redemptions`. EmDash builds a declared index on the first
scheduled tick after the deploy, as an expression index over the whole shared `_plugin_storage`
table. On D1 that writes about one index row per plugin-storage row, every plugin's rows included,
and counts against the daily rows-written limit (100,000 on Free); on Postgres the plain `CREATE
INDEX` holds writes to that table until it finishes. A large store on Workers Free should deploy
well clear of its daily write ceiling (early in the UTC day, not after a sale), and a large
Postgres store at a quiet hour. `product-orphans` soft-deletes a
commerce row whose CMS product is gone (deleted or in the trash) when the delete hook's own
soft delete was lost. It reads each live row's document through `ctx.content` (the
`content:read` capability already declared) and is built for a CMS read that LIES: on the
sandboxed path EmDash's bridge answers `null` for any D1 error. The gates, in order:

- **The CMS must list at least one product** in each run, or the run judges nothing.
- **A missing document is re-read twice on the spot.** A row that misses and is then FOUND by
  a re-read proves the host is answering "missing" for documents that exist. One such
  contradiction makes the whole run FLAKY: it records no strike, wipes the strikes of every row
  it read, and moves the walk past them. A real deletion misses on every look of every pass, so
  it never looks flaky.
- **A miss counts as a strike only in a run that read some other document successfully.** If
  nothing on the page was found, the run reads the product the list returned, and a `null` there
  is treated as an outage.
- **The row is tombstoned on the third strike,** each strike from a run at least fifteen minutes
  after the last. Any read that finds the document wipes its strikes. A list or canary trip
  wipes all strikes.
- **Strikes expire** after seven days, or four full passes when a pass takes longer, so a
  catalog whose pass outlasts a week (roughly 30,000 products on Free) still reaches the third
  strike.
- **Limits:** at most five tombstones a minute, a failed read never counts, and rows younger than
  fifteen minutes are not read.

Each of those stops logs a `cron sweep product-orphans` error line. Measured on an otherwise
idle store, a pass over a 1000-product catalog takes about 350 ticks (about six hours) on the
Workers Free preset, and about 7 on Paid. An orphan is tombstoned on the third pass that finds
it: on Free, a 1000-product catalog's orphan went after about 900 ticks, and worst case it is up
to about eighteen hours. The leg has no deadline, so it is never promoted ahead of other legs
by aging.

`product-reconcile` (#95) repairs a commerce row whose content sync was lost — every content hook
is fire-and-forget, and since publish atomicity a save of live content sends nothing, so a lost
publish no longer heals on the next save. It walks the CMS `products` collection through
`ctx.content` (`content:read`, already declared), a hundred documents a page behind the host's own
cursor (kept in `cron:sweep:cursor:product-reconcile`), reads each page's commerce rows, and
nominates every **published** document whose row is missing, behind the content's `updatedAt`,
carrying a different title, inactive, or out of step with the variant repeater, and every active
row whose document is **not** published (a lost unpublish). Each nominated product is then
repaired from a fresh read of its row and then its document: the publish hook's own sync (title,
activation, variants) from the live content — which is what `ctx.content` returns: a pending draft
lives in its revision, not the content columns — or a deactivation. Reading the row first means a
publish or unpublish landing mid-walk is never overwritten with a stale page. It never activates
a product its document read did not show published, never writes an unpublished product's title,
never touches a tombstoned row, never overrules a newer lifecycle event (every flip is
watermarked), writes no commercial field and touches no order.

One window is left: a merchant unpublish (or republish) landing between the repair's document read
and its activate (or deactivate) finds the row not yet flipped, so the hook's own flip is a no-op,
and the repair's flip then leaves the product wrongly buyable (or wrongly unbuyable). So every
repair is **checked** on the product's next visit — later in the same tick when the budget allows,
else the next tick the leg runs — by the same row-then-document read: a repair that held is
counted then; a document that moved meanwhile is repaired again at its own watermark; a repair
that did not hold on an unchanged document is logged as an anomaly ("attempted and is still out of
sync"), never as re-synced. The wrong state lasts until that visit, not until the next pass. The
row-then-document ordering assumes both reads see the primary database (one D1 session); it must be
revisited before D1 read replication (#490) is enabled. A product leaves the nominated set once its
repair is checked or has failed, so a repair that cannot hold never pins the walk; one cut short by
the tick's query ceiling three runs in a row is stepped past and logged. Either is tried again on
the next pass.

**Rows read, and the pass interval.** A pass is cheap in queries but not in D1 *rows read*:
EmDash's `ContentRepository.findMany` runs an unbounded `COUNT(*) … WHERE deleted_at IS NULL` over
the whole collection beside every page, so a pass over N products reads about
**N·⌈N/100⌉ + 2N rows** (the counts, the pages, the commerce rows), plus a handful per product
repaired. Each page is listed **once a pass**: a pass the budget stops part-way keeps the page's
nominated products in its cursor document and resumes them by id, so the count is not paid again
per tick of a long repair. For an in-sync catalogue:

| Products | Rows read a pass | Share of D1 Free's 5M rows/day at one pass a day |
|---:|---:|---:|
| 1 000 | ~12 000 | 0.2% |
| 3 000 | ~96 000 | 1.9% |
| 5 000 | ~260 000 | 5.2% |
| 10 000 | ~1 020 000 | 20% |
| 20 000 | ~4 040 000 | 81% |

**Above about 15 000 products, do not run the Free preset's interval on Workers Free**: one pass a
day of 20 000 products reads about 4 million of the 5 million rows D1 Free allows, leaving the
storefront almost nothing. Move the store to Workers Paid (and the Paid preset), or keep the
catalogue on Free below that size.

So passes are spaced **from the start of one to the start of the next**: 24 hours on Workers Free
(any background-work setting below the Paid preset), 6 hours on Workers Paid. On Free, six-hourly
passes of a 10 000-product catalogue would read four fifths of the day's allowance — and past it
every D1 query (storefront, checkout, admin) fails until the UTC reset. On Paid, D1 includes 25
billion rows read a month, so four passes a day are noise. Between passes the leg reads only its
cursor document, every fifteen minutes. A pass that runs long cannot pull the next one closer, and
an unfinished pass resumes every tick until it ends.

Costs in queries: an in-sync page costs seven (the list's four, two row reads of fifty ids each —
D1's 100-parameter bound — and the cursor write), and no commerce writes. Every visit to a
nominated product reads five (recording the attempt, the row, the document); a repair adds the
sync's six writes (eleven in all) or a deactivation's two (seven), and the visit that checks it is
the five reads alone. The leg only starts when its floor fits — the entry's seven queries (the
cursor read, the list, the row reads) plus one repair's eleven, of the roughly twenty-eight a Free
tick can spend — so on a busy Free store, where the customer-facing legs take most of each tick,
repairs run only on the quieter ticks. Measured on Free with the cursor's reads and writes counted,
107 drifted products healed in 335 ticks — about 460 repairs a day at the leg's own pace — so a
catalogue-wide outage of 1000 products would take about two and a half days; on the Workers Free
preset the daily cap below holds it to 200 a day, about five days. "Publish changes" repairs a
product at once.

**Rows written, and the daily repair cap.** By the same index model as "Draining a backlog writes
rows" above, every `_plugin_storage` document write is about 49 rows written, and a repair's sync is
about three document writes (the upsert, the activate, the variant write) plus its SKU claims —
about **150 rows written a product**. At the leg's own pace (about 460 repairs a day) a first
install over an existing catalogue, where every product has no commerce row, would write about
70,000 rows a day for days on end, which beside `prune-carts` and the store's own traffic passes
D1 Free's 100,000 a day, after which every write fails until the UTC reset. So on the Workers Free
preset the leg makes at most **200 repairs a UTC day** (counted in its cursor document): about
30,000 rows written. Only a repair's writes count — not the visit that checks it, not a product
found in sync, not one its own hook synced first — and the count is kept when the tick's query
ceiling stops a run part-way through a repair. Once the cap is reached the leg stops repairing,
is stamped and runs only at its fifteen-minute cadence (one kv read, and the checks of the day's
last repairs); the pass keeps its start, its page and its nominated products and carries on after
00:00 UTC, so nothing is skipped. A first install over N products therefore heals in about
**N / 200 days** on Free (a 1 000-product catalogue in five days; "Publish changes" repairs any one
product at once). On Workers Paid there is no daily cap.

Together the two capped legs bound the sweep's **daily rows written on Free** at about 60,000:
`prune-carts` about 30,000 (300 carts) and `product-reconcile` about 30,000 (200 repairs), leaving
about 40,000 of D1 Free's 100,000 for the store's own traffic (carts, checkouts, orders, admin
edits) and the sweep's own cursor and tick-state writes. Both caps key off the **Background work
per minute** setting the same way — 50 or less counts as Free — and both are derived from the index
model, not measured on D1. Overlapping ticks can pass the day's repair cap by at most one run's
repairs.

What it does not repair: a **leaked price** from before PR 1b (the sync carries no commercial
field and the published content holds no price to compare against — re-price it in Pricing &
inventory), a **leaked title written under the save key the live content derives** (a pending
pre-fix draft at the same `updatedAt` and `version`: the upsert would replay it as a no-op, so
none is sent — publishing the product again repairs it), and a **variant orphaned by a leaked
draft** that the live repeater still declares (the orphan carries the draft's newer watermark and
a declare resurrects only on a strictly newer one — publishing the product again brings it back).

Logs: a product with no commerce row at all — every product, on a catalogue published before the
plugin was installed — is a first sync, logged at info. Any other repair logs a
`cron sweep product-reconcile` warning naming the product and why ("a lost publish sync", "a lost
unpublish"); the leaked-title case above is said once a pass at info; reaching the Free daily
repair cap is said once a day at info; a failed or no-op repair logs an error.

**A dense block of real orphans is struck out like any rows,** five a minute at most. An example
is a bulk delete of an import whose hooks were all lost. Measured with every read truthful:
- 60 products, with 20 adjacent orphans plus one more, were all tombstoned by tick 123 on Free
  and tick 34 on Paid.
- 250 products, with a 40-orphan block and two lone orphans, by tick 379 on Free and tick 41 on
  Paid.

**The residual risk on a sandboxed host:** a CMS database failing reads at random is
indistinguishable from deletions, until a re-read contradicts it. The simulations tombstoned no
live product across 128 seeded cases:
- 40 live products, 360 one-minute ticks, `get` failing to `null` with probability 0.15–0.9,
  alone or with the list failing too, four seeds, both presets;
- 250 live products with p straddling 0.2–0.35, at 0.5 and 0.9, and in twenty-minute bursts
  (0.6/0.25, 0.9/0.3), three seeds, both presets.

That is seeded PRNGs and one independent-failure model, not a proof. A host that returned `null`
for one specific live document on every read, while other reads succeeded, would be
indistinguishable from a deletion; nothing in EmDash 1.0.1 is known to do this. The tombstone is final, so
a live product ever struck out that way sells again only once it is duplicated in the CMS (a new
id, and its pricing re-entered).

**While CMS reads are failing, real orphans WAIT.** A flaky run strikes nothing, and every list
or canary trip wipes the strikes gathered so far. So under sustained failures (on Paid, under
any; on Workers Free, even under a list that fails one time in twenty) an orphan may not be
tombstoned for hours, or at all while the failures last. That is the safe direction.

The outbox, the two expiry legs, the
intent-cancel drain and the hold-intent completer run every tick, so on an idle store a
fifteen-minute hold expires within about a minute of its deadline and a queued email goes out
within about a minute.

**Each tick is budgeted — in time and in D1 queries.** The `cron` hook declares a 15 s timeout
(the host stops waiting for a hook after it; raised from EmDash's 5 s default so a slow email
provider's send fits). The tick's budget starts at hook entry: 9.5 s of wall time — waiting on
D1 and the provider, not CPU, so Workers Free's CPU limit is unaffected — and, by default, 30 storage/kv/egress calls (each one D1 query or one
subrequest — see "Background work per minute" below), checked before each leg and before each
unit of work inside one (each hold or order flip, each outbox claim, each scanned page or row,
each reporting day, each pruned challenge). The expiry legs' candidate lists are bounded by a
count and stopped by the budget too, and never offer a lapsed hold that can no longer be expired
(so a few such holds cannot block the live ones behind them). **The budget is a hard ceiling**:
the counter refuses any call past it (the leg it stops is logged by name as `stopped at the
tick's query ceiling` and resumes next tick), so no tick can use more than the setting — on the
Free preset, never more than 30 of Workers Free's 50.

**Which leg runs first.** `cancel-intents` first (a due PaymentIntent is withdrawn before
anything else spends the tick), then `expire-orders`, the outbox, `hold-intents` (a paid order's
stock commit) and `expire-holds`, then `late-refunds`, and housekeeping last. Each leg may use
only a share of the tick, never less than one unit of its own work; a leg its share stopped
gets a second go on whatever the other legs left. **No leg is starved**: a leg passed over for
three ticks in a row with work goes to the head of the next tick (right behind
`cancel-intents`), and one passed over for nine goes ahead of even that, once — on Free a hold
expiry does not fit behind an intent cancel at all. A tick that did work logs one
line naming what each leg spent:

```
[otta] cron sweep used 27 of 30 queries (180ms of 9500ms): cancel-intents 2, expire-orders 14,
  order-emails 8, overhead 3; deferred to the next tick: hold-intents, expire-holds
```

The expiry never flips an order whose payment intent is due and not yet withdrawn: the
withdrawal comes first, in the same tick or the one before. And a provider call is always
recorded. An email is sent, or an intent withdrawn, only with room left for its record, and
the record is never refused once the call has been made. Above the Free preset the record's
window (at most 4 calls) is kept out of the ceiling the legs plan against, so a tick never
uses more than its configured budget. On the Free preset (30) it is not: reserving it cost a
quarter of the Free expiry pace. There, if an estimate is ever wrong, the line ends
`N past the ceiling to record a provider call`, and the tick uses at most 34 of Workers
Free's 50, which still leaves the host 16. **If you set a custom budget, keep it at least 4
under your plan's per-invocation limit after the host's own share.**

A leg the budget did not reach is listed as deferred and runs on a later tick — that is not a
failure, and a backlog (say, hundreds of expired holds after an outage) drains over several
ticks. Five deferrals in a row of the same leg log a warning.

**Order emails: every timeout counts as an attempt.** Each send gets at most 5 s, or what is
left of the outbox's share of the tick, whichever is sooner — and that limit covers the whole
send, including building the sender; 5 s is long enough for a slow-but-working provider to
deliver. Just before sending, the sweep checks the time again (the claim and the order reads take
time of their own); with too little left it hands the email back untried, due again in 30 s (so a
short tick cannot keep one email at the head of the queue). A send that **times out** counts as
an attempt and is retried on a later tick: `ctx.email` has no idempotency key, so the provider may
have delivered it, and counting it bounds the duplicates a slow provider can cause
([ADR-0031](./adr/0031-email-through-emdash-host.md)). A provider failure counts the same way,
and an email is parked `failed` after five attempts. With **no email provider selected** the
email is handed back without counting an attempt, due again in 5 minutes. There is no admin
action to re-queue a parked email yet (a follow-up); until there is, a parked email is a provider
or configuration problem to fix at the provider, and the customer will not receive that message.

**The plan this assumes.** Cloudflare caps one Worker invocation at **50 D1 queries and 50
subrequests on Workers Free** (1000 queries and 10,000 subrequests on Workers Paid; see
Cloudflare's [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). The scheduled event
that runs the sweep also runs EmDash's own executor, scheduled publishing, cleanup and heartbeat,
so by default the sweep keeps itself to 30. Measured on the document store (each storage or kv
call counted once, `cron-leg-costs.test.ts`): an idle tick is **8 queries**; a tick where the
scans come due adds about 17–20 more; one email is about **12** (the claim, the order, the
store-name and sign-in-page reads, the send, marking it sent), plus 1 once per tick that
has an email due, to check the host has not just answered "no email provider", one hold
expired about
**20** with its list on Free, one order expired **13** for a one-line order (22 before the
QA2 fix; a three-line order 23, was 40), one order whose hold bookkeeping needs completing
about 7 plus 7 per extra line. A closed day's first rollup heal costs two calls per order
transition it absorbs; it is spread over ticks (about five absorbed a Free tick) instead of
being done in one.

**What Workers Free (30) sustains** — measured by `cron-sweep-backlog.test.ts`, which seeds work
in every leg at once (50 lapsed orders, ten of them with a payable intent, ten abandoned carts,
five paid orders owing their stock commit and confirmation, expired challenges, a stranded sku
carry, lost sku pointers, an unhealed closed day, orphaned coupon redemptions and a late refund)
and sweeps it minute by minute: no tick passed 30 queries; every leg did some of its work within
seven ticks and no leg waited more than six in a row; all 50 orders expired by minute 71 (about
0.7 a minute, while everything else progressed too); everything was done by minute 120. With
only an expiry backlog it is about **one order a minute**. So an order that lapses behind a
backlog of N others on Free stays `pending` (its stock off sale; the pay page already refuses
it) for about N to 1.5·N minutes. Free sustains about **0.7 expiries a minute** under a backlog; a
store whose orders lapse faster than that holds their stock off sale longer and longer — raise the
budget (the Paid preset, on Workers Paid) in that case. A store that abandons more than about one
checkout a minute, or that wants a lapsed order's stock back on sale within a minute or two under
load, has outgrown the Free preset.

`cancel-intents` (withdrawing a lapsed or unpaid-cancelled order's Stripe PaymentIntent) runs
first in every tick: about 5 calls per order (one of them the Stripe cancel; up to 7 when Stripe
refuses the cancel and the intent is read back and, on its last attempt, given up) plus up to 5
secret reads to build the gateway, at most 20% of the time and 30% of the queries, 1–10 orders a
tick scaled from the budget, each cancel given a fixed 1.5 s and started only with that much
left; the intents of the orders the tick's expiry is about to flip are withdrawn right after
that flip, in the same tick. `late-refunds` (resuming a late payment's automatic refund after a
transient Stripe failure) is **best-effort**: a tick with nothing due pays one query for it and
logs nothing. One resume is about 20 calls (two of them Stripe subrequests, the rest mostly the
refund's finalize and its reporting write) plus up to 5 secret reads to build the gateway; a
unit is started only with 3.5 s left (a pre-flight, a whole 2.5 s create — a create that times
out is ambiguous, so it is never started with less — and the writes after it). It runs after
the money legs and the outbox; only where it cannot fit there — **Workers Free** — does it,
while refunds are pending, **lead one tick per fifteen minutes** (ahead of even
`cancel-intents`), resuming one refund: that lead tick takes most of that minute's budget, so
the intent cancels and the expiry wait one minute together (at most once per fifteen minutes,
and only while late refunds are pending). In the other minutes a cheap give-up step — no Stripe call, its own list of the
oldest retries, about 9 calls — runs at the head of the tick, so a refund past the ~3-day limit
is handed to a human within a tick on every plan. On Paid it never leads and resumes up to five
a tick, within 40% of the query budget.

**Background work per minute (Settings → Checkout & holds).** The query budget is an
operational setting, beside the cart hold TTL, with two presets: **Workers Free (30)**, the
default, and **Workers Paid (600)** — set it to the plan the store actually runs on. The sweep
reads it once per tick (that read counts against the budget) and sizes its per-tick bites from
it and the measured costs: Free takes 1 hold, 1 order and 1 email a tick at most (a second never
fits a Free tick); Paid up to 18, 18 and 15, which clears a backlog of the size QA saw (14–18 due
in one tick) in about one tick.
The 9.5 s time budget applies on both plans, so on Paid it — not the query count — is usually
what ends a busy tick. **30 is also the minimum**: below it the costliest critical unit (a hold
expiry with its list, about 20 calls, plus the tick's own reads and reserve) could not start
behind the other legs' due checks, and hold expiry would stall. Any whole number from 30 to 900 is accepted on save
(anything else is refused with a message, never clamped); a stored value outside those bounds is
ignored for the Free preset. **Choosing Paid on Workers Free is a mistake the platform
punishes**: ticks then fail with D1's "too many API requests by single Worker invocation" once
there is a backlog. Against D1's *daily* Free limits the cadence is small: about 12,000 queries a
day from the sweep when idle (8 a minute, plus the scans every fifteen), writing almost none. The
idle reads touch a handful of rows each; a scan run reads up to a page (100 rows) of its
collection, and each coupon the recount judges costs two index-served counts over that coupon's
own redemptions. That stays well under the 5 million rows read and 100,000 rows written a
day for a store of ordinary size. The host's own share of each scheduled event was not measured; on Free, 20 queries is the
allowance left for it, and on Paid the 600 preset leaves 400 of the 1000.

**Choosing the budget.**

- **On Workers Free, keep 30.** It is the most the sweep can take and still leave the host's
  own work in the same event (its executor, scheduled publishing, cleanup, heartbeat) about 20
  of the 50. Watch the `cron sweep used N of 30 queries` lines: a store whose ticks are
  routinely full, with `deferred to the next tick` naming the same legs minute after minute, or
  with expiry lag growing after a sale, needs Workers Paid — not a higher Free number.
- **On Workers Paid, choose 600.** That clears tens of expiries and emails a tick and leaves 400
  of D1's 1000 per-invocation queries for the host. Anything up to 900 is accepted, for a store
  that measured its host share; past that the 9.5 s time budget, not the query count, ends a
  busy tick anyway.
- **Never more than the plan allows.** A number above 50 on Workers Free makes the sweep plan
  ticks the platform refuses partway (D1's "too many API requests by single Worker invocation"):
  the work is not lost — every unit is a guarded write a later tick completes — but nothing
  finishes reliably.
- The log line's per-leg figures say where a full tick went: a leg that keeps taking most of the
  budget with the same work (a large closed day's rollup heal, a huge outbox) is what to
  investigate, not the budget.

Two kinds of `wrangler tail` lines mean something beyond a slow tick:
`[cron] Hook failed for otta:commerce-sweeps: Error: Hook timeout` (a single storage call or
email request hanging past every guard — the email send is the usual suspect, so check the
provider), and D1's "too many API requests by single Worker invocation" (the host's own work in
that event used more of the 50 than the 20 the sweep leaves it).

Nothing needs to register that task by hand. The site lists the plugin in its `plugins`
array, so the host fires `plugin:activate` for it on its own at most once (EmDash 1.2+, at
the first boot with no plugin state row, never retried; an admin re-enable fires it again);
the plugin does not rely on that. It wraps its four
content-sync hooks and the two public catalog routes (product list and product page) in
`withSweepBootstrap` (`packages/plugin/src/cron/index.ts`), which ensures the task exists
once per isolate on the first such request (the tick does the same, for a cron-only isolate)
and retries on the next if that fails. It reads the task row first and writes only when the
schedule differs.

Every leg is **idempotent** and runs in its own try/catch with its own label, so a leg that
throws cannot starve the others beside it; a tick always returns a summary. A leg logs one line
when it did work or has more left, nothing when idle, and one `console.error` on failure
(visible in `wrangler tail`). Per
[ADR-0019](./adr/0019-commerce-aggregates-are-one-document-each.md), these sweepers are not
an optimization — a coupling that spans two aggregates is made idempotently completable
rather than transactional, so **a missing sweeper is a correctness bug**. Do not relax the
site's cron: the task is due every minute, so a slower trigger directly lengthens how long an
expired hold keeps stock off sale and how long a queued email waits.

**Scaling.** Commerce truth is one document per aggregate in the site's D1 database, written
by compare-and-set; every command carries an idempotency key the store enforces once-only,
and the sweeps are idempotent, so concurrent isolates racing the same sweep never
double-release or double-send. A hot aggregate therefore retries rather than blocking: the
contention budget is a measured number recorded in ADR-0019, not a hope. The scaling ceiling
is that single D1 database.

**Access logs and Stripe's return URL.** After a card payment Stripe redirects the buyer to
`/orders/<id>?payment_intent=…&payment_intent_client_secret=…&redirect_status=…`. The order page
answers that one request with a 303 to `/orders/<id>` (`private, no-store`) with Stripe's
parameters removed (the page's own `error` parameter, if any, is kept), so the secret does not
stay in the browser's URL, but **the request itself still appears in any access log in front of
the site**. The client secret does not expire, and with the store's publishable key (public) it
reads the PaymentIntent back, including the buyer's name and shipping address. Redact the query
string on `/orders/*` (at least `payment_intent_client_secret`) wherever you log requests.
Otta's own code does not log the URL on that route. The browser may still keep the URL it was
redirected from, secret included, in its history; nothing on the server side can remove that.

- **Cloudflare.** Otta's code logs nothing on the return request: it answers with the 303
  first. **Workers Logs invocation logs do record the request method and URL, query
  included,** and keep them for 3 days (Free) or 7 (Paid). The shipped `wrangler.jsonc` and
  `wrangler.playground.jsonc` therefore set `observability.logs.invocation_logs` to `false`
  (console logs stay on) because of this secret, so there is no per-request line for it.
  Console lines that other code writes during a request may still carry that request's
  metadata, so treat Workers Logs as sensitive for their retention window. If you turn
  invocation logs back on, the secret sits in Workers Logs for 3–7 days. The same applies to
  Workers Observability traces (`observability.traces`, off by default) if you enable them,
  because spans may record the URL. `wrangler tail` shows the URL live and stores nothing; a Tail Worker receives
  `event.request.url`, so don't let one persist the query. For Logpush, in the job's field
  selection: on the `http_requests` dataset leave out `ClientRequestURI` and keep
  `ClientRequestPath` (there is no `ClientRequestQuery` field in that dataset); on
  `firewall_events`, drop `ClientRequestQuery` (and `ClientRefererQuery`); on
  `workers_trace_events`, the URL is inside `Event`, which is one JSON object and cannot be
  filtered field by field, so leave `Event` out of the job's fields or do not push that dataset
  at all. Field names and options change, so confirm them in Cloudflare's
  [Logpush docs](https://developers.cloudflare.com/logs/logpush/) and
  [Workers Logs docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
- **Caddy.** Inside the site block, filter the access log's request URI:

  ```caddyfile
  log {
  	output file /var/log/caddy/access.log
  	format filter {
  		wrap json
  		fields {
  			request>uri query {
  				delete payment_intent_client_secret
  			}
  		}
  	}
  }
  ```

  The `wrap json` line and the `fields { … }` wrapper are what Caddy 2.6 needs. Without
  `wrap`, 2.6.2 refuses to load the config (`missing "wrap"`); newer versions accept both
  lines, so leave them in. The filter acts on every request's URI, which is harmless for other
  routes. Use `replace payment_intent_client_secret REDACTED` to keep a marker instead. Apply
  it with `caddy validate --config /etc/caddy/Caddyfile` and then
  `caddy reload --config /etc/caddy/Caddyfile` (or `systemctl reload caddy`), not a restart: a restart takes down
  every site in the Caddyfile, and a reload with a bad config keeps the old one running. See
  Caddy's [log directive docs](https://caddyserver.com/docs/caddyfile/directives/log#filter).

  Caddy's error log is a separate matter, as nginx's is below. On a proxy error (the app
  restarting while a buyer comes back from Stripe, say) the `http.log.error` logger records the
  full request URI, query included, and the site's `log` block does not filter it: that block
  covers the access log only. Under systemd that log goes to the journal, where `sed` cannot
  reach it. Restrict who can read the journal (the `systemd-journal` and `adm` groups), and to
  purge it, run `journalctl --rotate && journalctl --vacuum-time=1s` (or a longer age), which
  drops archived entries of **every** unit on the host, not just Caddy's; or delete the old
  journal files under `/var/log/journal/` yourself.
- **nginx.** Log a URI with the query stripped for `/orders/`, instead of `$request`. This must
  **replace** your logging, not add to it: remove or change every existing `access_log`, in
  `http {}` and in any `server {}` or `location {}` that sets its own, because several
  `access_log` directives all write, and any left in place keeps logging the full URL.

  ```nginx
  # http {} context
  map $request_uri $otta_logged_uri {
  	~^(?<orders_path>/orders/[^?]*)\? $orders_path;
  	default $request_uri;
  }
  log_format otta '$remote_addr - $remote_user [$time_local] '
                  '"$request_method $otta_logged_uri $server_protocol" '
                  '$status $body_bytes_sent "$http_referer" "$http_user_agent"';
  access_log /var/log/nginx/access.log otta;
  ```

  nginx's `error_log` is a separate matter: at the default `error` level it records
  `request: "GET …?query"` for proxy errors (an upstream that is down, a timeout), and its
  format cannot be changed. Restrict access to it and include it in the purge below. Also check
  any upstream or CDN logs.

**Purge, do not just rotate.** Delete or scrub access logs written before the redaction was in
place, including rotated `.1` and `.gz` archives and copies shipped elsewhere (a SIEM, Logpush
destinations). Rotation alone keeps them. Workers Logs age out after 3–7 days. The secret
cannot be revoked, so removing it from the logs is all there is to do. For example:

```sh
# the live log: rewrite it in place, keeping the same file, so the server keeps writing to it
# (sed -i would swap in a new file and the server would go on writing to the deleted one).
# Lines written between the sed and the cat are lost or overwritten, so do it in a quiet period.
sed -E 's/payment_intent_client_secret=[A-Za-z0-9_]*/payment_intent_client_secret=REDACTED/g' access.log > access.log.tmp && cat access.log.tmp > access.log && rm access.log.tmp
# rotated plain files (names vary: access.log.1 for nginx)
sed -i -E 's/payment_intent_client_secret=[A-Za-z0-9_]*/payment_intent_client_secret=REDACTED/g' access.log.1
# .gz archives (access.log.2.gz for nginx; Caddy gzips by default: access-<timestamp>.log.gz):
# sed -i would match nothing in compressed data, so rewrite each one
zcat access.log.2.gz | sed -E 's/payment_intent_client_secret=[A-Za-z0-9_]*/payment_intent_client_secret=REDACTED/g' | gzip > access.log.2.gz.new && mv access.log.2.gz.new access.log.2.gz
```

Or simply delete archives written before the redaction.

**Upgrading and rolling back.** Deploy a new version **all at once** (`wrangler deploy`),
not as a gradual rollout that keeps old and new Workers serving side by side. A release that
changes a stored document's shape migrates it forward on first write, and an old Worker still
serving traffic can write the old shape back over it. The reporting day document is the live
case ([ADR-0023](./adr/0023-reporting-rollup-is-a-guarded-delta.md)). A pre-delta Worker's
**rollup** rewrites a migrated day document from the copy it read: any events counted since
that read are lost, and its own state move is kept only in an old-style field the new code
ignores. The next event on that day clears the old field in one write, logs a `tainted`
reporting anomaly, and carries on from the counters that survived. A pre-delta Worker's
**reconcile** writes the old shape back, which the new code migrates forward on its next
write. Either way the day's figures can be wrong (almost always low; a rare race during the
overlap can count one event twice) until a reconcile covering it runs, and
the scheduled reconcile reaches a day only once it has closed. So after a rollback past such a
release, or a rollout that overlapped versions, treat today's report figures as provisional
until then. Orders, stock and payments are unaffected — only the reporting rollup is.

The same rule covers the Stripe return scrub (PR #550). The 303 records the return in a cookie
and the next request reads it, so in a gradual rollout the two can be served by different
versions, and the order page can briefly show "awaiting payment" with **Complete payment** for an
order that was paid. That does not double-charge, but it does not fix itself either: the page
keeps showing it until the buyer reloads. A buyer who presses **Complete payment** and pays
again is paying on an order that is still `pending`, and **Complete payment** resumes that
order's own PaymentIntent (`lib/checkout-resume.ts`), not a new one. Stripe refuses to confirm a
PaymentIntent that has already succeeded or is processing, and the pay page treats that refusal
as "landed" (`refusalOf` in `pages/checkout/pay.astro`) and sends the buyer back to the order
page. No second charge is made. A reload after the cut-over shows the right state.

**Stock stranded under a cancelled order (#599).** Before this fix, the cron sweep's recovery of
a crashed checkout could adopt a hold for an order that an admin cancelled (or that expired) at
the same moment. The units then stayed off sale for good, because nothing releases an adopted
hold of a terminal order. The fix stops **new** cases. Units already stranded on a live store are
returned by the `stranded-holds` sweep leg (#631), with no operator step: it walks the
inventory and releases each hold still `adopted` by an `expired`, `cancelled` or `failed` order
that owes no other hold work. Each release logs one line naming the sku, the order and the units
it returned: `[otta] cron sweep: released 1 hold(s), 2 unit(s) of SKU-42, still adopted by
cancelled order … (#631)`. A run the tick's budget cuts short carries on the next minute, so a
pass over a large inventory takes as many minutes as it needs, not fifteen-minute steps. Once a
whole pass finds nothing, the leg records that the repair is done and stops reading the inventory
(see §5).

**Before deploying this release**, run this **read-only** query (D1 / SQLite) and keep its output:

```bash
wrangler d1 execute YOUR-D1-DATABASE-NAME --remote --config wrangler.local.jsonc --command "SELECT inv.id AS sku, h.value ->> '$.reservationId' AS reservation_id, h.value ->> '$.qty' AS qty, h.value ->> '$.orderId' AS order_id, o.data ->> '$.state' AS order_state FROM _plugin_storage inv, json_each(inv.data, '$.holds') h JOIN _plugin_storage o ON o.plugin_id = 'otta' AND o.collection = 'orders' AND o.id = h.value ->> '$.orderId' WHERE inv.plugin_id = 'otta' AND inv.collection = 'inventory' AND h.value ->> '$.state' = 'adopted' AND o.data ->> '$.state' IN ('expired', 'cancelled', 'failed')"
```

Each row is one hold still `adopted` by an order that no longer claims it; `qty` is the units it
keeps off sale. No rows means nothing is stranded. If there are rows, **do not** correct the
counts with a manual stock adjustment now: those units come back on their own when
`stranded-holds` releases the hold, and an adjustment would count them twice and let the store
oversell. Do not edit `_plugin_storage` rows by hand either.

**If you already corrected stock by hand** for some of those skus (before this release), the
leg's release adds those units a second time. Keep the query's output, and as each release line
for one of those skus appears in the log, take back the quantity you added by hand (up to the
units the line names) with a stock adjustment on that sku. Skus you never adjusted need nothing.

**Upgrading the EmDash host (0.38 → 1.0.1).** The host runs its own schema migrations on the
**first request** after the deploy, with no separate step: EmDash 1.0.1 adds
`078_menu_item_translation_groups` through `089_auto_seed_completion` on top of 0.38's
`077_plugin_storage_revisions`. Most of them are **not reversible**, so rolling the Worker back
to 0.38 afterwards does not roll the database back. **Before deploying, take a D1 backup** —
note a Time Travel bookmark (`wrangler d1 time-travel info <database>`) or export the database
(`wrangler d1 export <database> --remote --output=<file>.sql`) — so a failed upgrade can be
restored with `wrangler d1 time-travel restore <database> --bookmark=<bookmark>`. After a
restore, check Stripe for payments made since the bookmark: a payment for an order the restore
removed is acknowledged as `ORDER_NOT_FOUND` and is not refunded automatically — refund it from
the Stripe dashboard. The same holds
for any later host release that adds migrations (`sites/staging/test/host-pin.test.ts` pins the
reviewed tip, so a new one fails CI first).

**Upgrading the EmDash host (1.0.1 → 1.3.1).** Two more host migrations, both for EmDash's own
redirects table and neither reversible: `090_redirect_enable_loop_guard` (a trigger that refuses
to re-enable a redirect into a loop) and `091_redirect_artifacts` (new `_emdash_redirect_state`,
`_emdash_redirect_artifacts` and `_emdash_redirect_generation_artifacts` tables, plus revision
triggers on `_emdash_redirects`). No Otta table or plugin-storage row is touched. Take the same
D1 backup first. The first boot on 1.3.1 also runs each config plugin's `plugin:install` /
`plugin:activate` once (new in 1.2). Otta's handlers never fail, but if the Worker log shows
`EmDash: plugin:install failed for config plugin "…"; disabling it` (or `plugin:activate`
failed), that plugin and its cron stay off until an admin re-enables it under **Plugins**.

One behaviour change on the Worker: since 1.3.1, a site in the default `auto`
migration mode whose migrations a request could not finish answers **503** until they are
applied, instead of serving pages without content. If a deploy answers 503, read the Worker log
and apply the pending migration from the CLI, after §2.1 step 4's build (which writes
`.emdash/migrations.json`). The CLI does not find the database on its own: point it at
`wrangler.local.jsonc` (or name the D1 with `--d1 <name|uuid>`), and set
`CLOUDFLARE_API_TOKEN` (D1 edit on the account) plus `CLOUDFLARE_ACCOUNT_ID` unless that file
sets `account_id`:

```bash
cd sites/staging
pnpm exec emdash migrate --status --wrangler-config wrangler.local.jsonc   # pending, lock id
pnpm exec emdash migrate --wrangler-config wrangler.local.jsonc            # --take-over-lock <id> if stuck
```

A non-interactive run (CI) also needs `--expected-target-fingerprint` with the fingerprint
`--status` prints. A site still on **0.38** that jumps straight to 1.3.1 should run this
**before** deploying, and deploy right after it completes: 1.3.1's Worker will not start a
content-sized migration (`079_datetime_normalization`, which rewrites every entry and revision)
on a request once it would touch more than 5,000 rows, and answers 503 until it is applied. A
smaller site still migrates on its first request, but running it from the CLI first is safe
either way. See EmDash's
[core-migrations guide](https://docs.emdashcms.com/deployment/core-migrations/).

## 6. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| A ~5 s stall on a new isolate's first request, an occasional 500 on a write, and `[emdash] A D1 session query hung …` in the logs | `global_fetch_strictly_public` + D1 `session` both on (emdash #1273): remove the flag from `wrangler.local.jsonc` (§2.4), rebuild, redeploy |
| `/products` empty right after deploy | Healthy (§1) — sample content lands via the wizard checkbox, not first boot |
| `POST /webhooks/stripe` reports `NOT_CONFIGURED` | The Stripe webhook signing secret is unset — provision it in admin Settings (§3) |
| Every Stripe delivery answers 503 after a deploy | The webhook signing secret or `OTTA_WH_TOKEN` reads "saved, but not valid" or "saved, but cannot be read" in Otta's Settings — re-enter it there; for "cannot be read", first check `EMDASH_ENCRYPTION_KEY` (§3) |
| Every Stripe delivery 401s | `OTTA_WH_TOKEN` set on the plugin side but not on the site (or the values differ) — §3 |
| An expired order is flagged `late payment … needs checking (…) — verify in Stripe` | A buyer paid after expiry and the automatic refund's outcome is unknown — most often a refund create that hit the settle path's 3 s timeout (the price of answering Stripe inside its delivery window: a timed-out create may still have been processed, so it is held `unverified` rather than retried blind) — or Stripe already shows it refunded, or the retries gave up after ~3 days. Check the PaymentIntent in Stripe before refunding again, then resolve the flag in the admin console |
| An expired order is flagged `late payment … automatic refund failed (…) — refund it manually` | Stripe definitively refused the automatic refund (or it would exceed the order total). Refund in Stripe or the admin console, then resolve the flag |
| An expired order is flagged `settle on expired` and nothing was refunded | The Stripe secret key is not set (so the settle route cannot refund), or it is a cancelled order with no audit evidence it was unpaid — refund in Stripe and resolve the flag |
| Sweeps never run | Nothing has bootstrapped the schedule, or the runtime wired no cron executor — check that the site's Cron Trigger is present and load `/products` or a product page once (§5) |
| An outbound call to Stripe never leaves | The host is not in the build-time `allowedHosts` allowlist (§4) — rebuild and redeploy |
| Order or sign-in emails never arrive, the outbox keeps them `pending` | No EmDash email provider is selected (Settings → "Payments & email" says so) — install and select one (§3 Email) |
| Uploading a product's download file answers `DOWNLOAD_RECORD_UNREADABLE` ("This product's stored file record is unreadable…"), and the log shows `[site-staging] download record unreadable: product "<id>"` | That product's stored download record has no string `key` (a hand-edited or corrupted document; Otta's own writes can't produce one). Buyers of it are refused at download time, and the hourly download-orphan sweep stops at this product each pass. There is deliberately no detach button. Fix the record in plugin storage: plugin `otta`, collection `product_commerce`, the document for that product id. Set `downloadAsset` to `null`, then upload the file again from the product's editor. Or, if the file is still in the DOWNLOADS bucket under `dl/<productId>/`, set a descriptor whose `key` is that object's key. Take a D1 backup first |

## 7. Playground (`try.otta.sh`)

A second deploy of `sites/staging`, not a second copy of the store. It is
EmDash's playground mode: one Durable Object database per visitor, the Otta
plugin registered trusted in-process (the same registration as §2, still no
Worker Loader), and the sample products priced on first open. Opening
`/playground` shows EmDash's loading page, which finishes at `/_emdash/admin`.
Otta then sends that boot to the shop at `/products`. A later visit to
`/_emdash/admin` stays in the admin; the note on each page links both.
The sample product photographs are static files under
`public/playground-products/` (Otta-branded tee, mug, and sticker shots
consistent with the marketing page; see `CREDITS.txt` there), served as
`<img src="/playground-products/…">`, not the Cloudflare Images binding.
EmDash's media library is the other set: seven demo rows whose bytes are
the static files under `public/playground-media/`. The library asks for
`/_emdash/api/media/file/playground-v1-<filename>`, and the playground
storage adapter loads that from `/playground-media/playground-v1-<filename>`
on the Worker's asset binding. See `CREDITS.txt` in that directory.
The marketing site's "Try in Playground" link is
`https://try.otta.sh/playground`.

```bash
pnpm --filter @urumi.ai/otta-site-staging build:playground
cd sites/staging && wrangler deploy
```

`wrangler.playground.jsonc` is what the playground build reads. The route
`try.otta.sh` is a custom domain. `wrangler deploy` creates that DNS record
only when the `otta.sh` zone is on the same Cloudflare account the deploy
token can edit. There is no shared Stripe key and no `EMDASH_ENCRYPTION_KEY`
on this worker: checkout tells the visitor card payments are not set up, which
is the truth. The Astro adapter adds a `SESSION` KV binding and Wrangler
provisions it on deploy; do not put a namespace id in the tracked file.

What this deploy is not: a one-click deploy of someone else's store, and not
a place that claims pay-per-crawl, MCP or x402. Those are not in the build.
