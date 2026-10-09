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
> checkout, orders, customers with magic-link auth, Stripe payments (x402 planned), tax,
> shipping, discounts, entitlements, reporting, and settings (the magic-link email needs an
> EmDash email provider and a sign-in page URL, §3 Email). The reference **storefront** covers
> catalog, cart and **card checkout**: `/checkout`, the Stripe pay page (`/checkout/pay`) and
> the order confirmation page (`/orders/<orderId>`) are built (ADR-0012), and so are the
> customer account pages (`/account/login`, `/account/verify`, `/account/orders`). Paid
> digital downloads are built too (issue #376): the merchant attaches a file to a digital
> product in the admin, and a buyer downloads it from the order page. One page surface is not
> built yet: the x402 payment gate (issue #27). Deploying today gives you a browsable
> catalog, carts with real inventory holds, magic-link customer accounts, digital downloads,
> and a Stripe card purchase end-to-end once Stripe is configured (§3). When #27 closes, this
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
  `EMDASH_ENCRYPTION_KEY` and `OTTA_WH_TOKEN`. Every payment **credential** is
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

The site's single `* * * * *` cron touches only D1, within free limits — the commerce sweep
budgets itself to fit Workers Free's 50 D1 queries per invocation by default. On Workers Paid,
switch Settings → Checkout & holds → "Background work per minute" to the Paid preset, or
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
   > - **A chargeback:** Otta does not act on disputes, and Mark refunded is refused while the
   >   payment shows as captured, so the console cannot close access for it today.
   > - **A cancellation whose refund timed out** ("refund status unknown"): the order stays
   >   uncancelled until you confirm that refund in Money → Refunds, which finishes the
   >   cancellation and closes access.
   >
   > A partial refund keeps access by design.
   >
   > **A file is replaced, never removed.** Past buyers keep access, so a product with a
   > download file stays Digital: the editor disables the Physical choice and says why.
   >
   > **Replaced files are not deleted.** Replacing a file uploads a new object and points the
   > product at it; every buyer's link serves the new file from then on. The old object stays
   > in the bucket, because deleting it could cut off a download already in progress, and an
   > upload whose save never happened (a closed tab) stays too. They cost storage, never access:
   > nothing serves a key the product does not name. To tidy up, open the bucket in the
   > Cloudflare dashboard (R2 → the bucket → Objects, filtered by the prefix
   > `dl/<productId>/`; wrangler has no `object list`), compare with the current key — the
   > product's Download file card shows it under the file's name — and remove the rest there or
   > with `wrangler r2 object delete your-downloads-bucket/<key> --remote`. Each object's metadata
   > records the product, the original filename and who uploaded it.

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
   there is no service URL to bake in; the optional x402 facilitator URL is read
   here too (§4):

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
> compatibility flag (issue #375). It was there so the site's calls to a commerce-service
> Worker on `*.workers.dev` were not blocked and stubbed 404; that service is gone
> ([ADR-0020](./adr/0020-one-deployable-plugin-owns-commerce-truth.md)), and nothing the
> Worker fetches today (§4) is on `workers.dev`. One consequence of running without it: a
> fetch to a hostname on the site's **own zone** is routed to that zone's origin, not back
> through Cloudflare, so never point `X402_FACILITATOR_URL` at the site's
> own zone.
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
> **The old pairing invariant is moot, but its rule stands:** the flag blocks the request the
> D1 Sessions API makes to route queries (emdash issue #1273). With EmDash 1.0.1 the symptom
> is a **~5 s stall on the first session query of every new isolate**; EmDash's hang guard
> then turns sessions off for that isolate, silently, and a **write caught in flight**
> (placing an order, a cart change, the Stripe webhook settle) **may be rejected** with a
> 500 rather than re-run. Nothing fails at deploy time. So the flag must never come back
> while a session mode is set. Pinned by `sites/staging/test/wrangler-config.test.ts` (flag
> absent, template hygiene) and `sites/staging/test/site-config.test.ts` (`"primary-first"`;
> never flag + session together), and enforced at **build** time on the config the build
> actually uses (`sites/staging/src/lib/wrangler-pairing.ts`, called from `astro.config.ts`).
>
> **Upgrading an existing deployment.** If you made `wrangler.local.jsonc` by copying the
> template before this change (§2.1 step 2), it still lists the flag. Before building this
> version, delete `"global_fetch_strictly_public"` from its `compatibility_flags`, leaving
> `["nodejs_compat"]`. If you don't, the build stops with:
>
> ```text
> Error: wrangler.local.jsonc sets the "global_fetch_strictly_public" compatibility flag, but
> D1 sessions are on (session: "primary-first", sites/staging/src/emdash-options.ts). …
> Delete "global_fetch_strictly_public" from compatibility_flags in wrangler.local.jsonc,
> then build again (DEPLOYMENT.md §2.4, "Upgrading an existing deployment").
> ```
>
> A **custom domain** on the site (issue #32) is what unlocks zone-level WAF rules.

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
| Stripe webhook signing secret | admin Settings (`settings:stripeWebhookSecret`) | for Stripe payments — **together with the secret key** (see below) | before enabling Stripe |
| Stripe secret key | admin Settings (`settings:stripeSecretKey`) | for Stripe payments — **together with the webhook secret** (see below) | before enabling Stripe |
| x402 pay-to + facilitator credential | admin Settings | for x402 | see the x402 box |
| Email provider (from-address, SPF, DKIM, its own key) | an **EmDash email provider plugin**, selected in EmDash Settings > Email — not otta | optional | when wiring real email |

- **`EMDASH_ENCRYPTION_KEY`** — generate with `npx emdash secrets generate`; never committed,
  never echoed into logs; **back it up in a password manager** (it protects the CMS's
  encrypted data — losing it strands that data).

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
  page also needs the build-time publishable key, `STRIPE_PUBLIC_KEY` — see
  [`sites/staging/README.md`](./sites/staging/README.md).

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
> **Three-decimal currencies (BHD, JOD, KWD, OMR) are payable** (ADR-0033 amendment). Stripe
> takes their thousandths only in multiples of 10, so checkout rounds the order's **final
> total** half-up to 0.010 and shows the difference as a signed "Rounding" row (at most
> ±0.005); line prices, discounts, shipping and tax stay exact. The rounded total is what is
> charged, settled and reported. Refunds in these currencies are multiples of 0.010 (or the
> whole remaining amount); the admin refuses anything else. An amount that is not a multiple
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

> **x402 does not take payments yet.** The old receipt-forwarding settle route
> (`entitlements/x402/settle`) is retired, and nothing settles an x402 payment until the
> content gate in [ADR-0028](./adr/0028-x402-content-gate-verifies-and-settles-through-the-facilitator.md)
> ships. The settings below still save, so a deployment can be configured ahead of it. The
> facilitator credential is meant to go **on the wire** as `Authorization: Bearer …` to the
> facilitator host, so provision a credential that was minted to be sent. The facilitator
> host must be in the plugin's `allowedHosts` — it is seeded at **build** time from the
> site's Astro config, not from `kv`, so changing facilitators is a rebuild, not a settings
> edit. The pay-to address and the accepted-networks list (default `eip155:8453`) are
> configuration, not credentials, and live alongside it in Settings.

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

## 4. Egress and `allowedHosts`

The plugin's only egress is `ctx.http.fetch`, gated by the descriptor's `allowedHosts`
allowlist (capability `network:request`). That allowlist is resolved at **build** time
(`packages/plugin/src/manifest.ts`, fed by `sites/staging/astro.config.ts`) and contains:

| Host | When |
|---|---|
| `api.stripe.com` | always |
| the x402 facilitator host | when a facilitator URL is configured |

No email host: email is not plugin egress. It goes through the host's `ctx.email`
(capability `email:send`, [ADR-0031](./adr/0031-email-through-emdash-host.md)), and the
EmDash email provider makes its own requests under its own allowlist.

The URL is `X402_FACILITATOR_URL`, read by `sites/staging/astro.config.ts` from
`process.env`, falling back to `sites/staging/.env`. Set it in the shell or in
`sites/staging/.env` **before** building (§2.1 step 4); unset, the facilitator is simply
unconfigured and no host is granted for it.

Stripe traffic goes through the same gate: `@otta-sh/payments-stripe` would default its
transport to `globalThis.fetch`, but the plugin constructs the live gateway with
`ctx.http.fetch` (`packages/plugin/src/payments/stripe-wiring.ts`) —
so the allowlist is the perimeter for `api.stripe.com` too. This
closes the caveat recorded in
[ADR-0020](./adr/0020-one-deployable-plugin-owns-commerce-truth.md) §2.

All of these are third-party hosts on the public internet. The Worker runs without
`global_fetch_strictly_public` (§2.4), so a URL on the site's **own** Cloudflare zone would
reach that zone's origin directly, skipping its Workers routes and security settings — keep
both URLs off the site's zone.

Because it is build-time, adding a provider means a rebuild and redeploy — a Settings edit
alone cannot widen it. That is deliberate: the allowlist is the perimeter, and an operator
editing a text field should not be able to move it.

## 5. Operations & scaling

**Cron.** The **site's** Cron Trigger is `* * * * *` — that drives the host's cron
*executor*, which claims due rows from its own task table. The **plugin** registers one task,
`commerce-sweeps`, also due every minute (`* * * * *`); the executor fires the plugin's `cron`
hook when it comes due. One task drives all twelve sweep legs: they share a store composition
and a clock, and splitting them would only put twelve rows in contention on the same documents. The
five scan legs (`sku-transfers`, `order-sku-index`, `reporting-heal`, `coupon-orphans`,
`product-orphans`) and the sign-in challenge prune run at most every fifteen minutes inside that
task (housekeeping: the scans read a page budget of a collection per run); a scan cut short by
the budget carries on next tick until its pass is done. `product-orphans` soft-deletes a
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
expiry or a stock-commit completion does not fit behind an intent cancel at all. A tick that did work logs one
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
day from the sweep when idle (8 a minute, plus the scans every fifteen), each reading a handful
of rows and writing almost none — well under the 5 million rows read and 100,000 rows written a
day. The host's own share of each scheduled event was not measured; on Free, 20 queries is the
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
array, so the host never fires `plugin:activate` for it; instead the plugin wraps its four
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

**Upgrading the EmDash host (0.38 → 1.0.1).** The host runs its own schema migrations on the
**first request** after the deploy, with no separate step: EmDash 1.0.1 adds
`078_menu_item_translation_groups` through `089_auto_seed_completion` on top of 0.38's
`077_plugin_storage_revisions`. Most of them are **not reversible**, so rolling the Worker back
to 0.38 afterwards does not roll the database back. **Before deploying, take a D1 backup** —
note a Time Travel bookmark (`wrangler d1 time-travel info <database>`) or export the database
(`wrangler d1 export <database> --remote --output=<file>.sql`) — so a failed upgrade can be
restored with `wrangler d1 time-travel restore <database> --bookmark=<bookmark>`. The same holds
for any later host release that adds migrations (`sites/staging/test/host-pin.test.ts` pins the
reviewed tip, so a new one fails CI first).

## 6. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| A ~5 s stall on a new isolate's first request, an occasional 500 on a write, and `[emdash] A D1 session query hung …` in the logs | `global_fetch_strictly_public` + D1 `session` both on (emdash #1273). The build refuses this pair, so check what was deployed: remove the flag (§2.4, "Upgrading an existing deployment"), rebuild, redeploy |
| `/products` empty right after deploy | Healthy (§1) — sample content lands via the wizard checkbox, not first boot |
| `POST /webhooks/stripe` reports `NOT_CONFIGURED` | The Stripe webhook signing secret is unset — provision it in admin Settings (§3) |
| Every Stripe delivery 401s | `OTTA_WH_TOKEN` set on the plugin side but not on the site (or the values differ) — §3 |
| An expired order is flagged `late payment … needs checking (…) — verify in Stripe` | A buyer paid after expiry and the automatic refund's outcome is unknown — most often a refund create that hit the settle path's 3 s timeout (the price of answering Stripe inside its delivery window: a timed-out create may still have been processed, so it is held `unverified` rather than retried blind) — or Stripe already shows it refunded, or the retries gave up after ~3 days. Check the PaymentIntent in Stripe before refunding again, then resolve the flag in the admin console |
| An expired order is flagged `late payment … automatic refund failed (…) — refund it manually` | Stripe definitively refused the automatic refund (or it would exceed the order total). Refund in Stripe or the admin console, then resolve the flag |
| An expired order is flagged `settle on expired` and nothing was refunded | The Stripe secret key is not set (so the settle route cannot refund), or it is a cancelled order with no audit evidence it was unpaid — refund in Stripe and resolve the flag |
| Sweeps never run | Nothing has bootstrapped the schedule, or the runtime wired no cron executor — check that the site's Cron Trigger is present and load `/products` or a product page once (§5) |
| An outbound call to Stripe never leaves | The host is not in the build-time `allowedHosts` allowlist (§4) — rebuild and redeploy |
| Order or sign-in emails never arrive, the outbox keeps them `pending` | No EmDash email provider is selected (Settings → "Payments & email" says so) — install and select one (§3 Email) |
