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
> checkout, orders, customers with magic-link auth, Stripe + x402 payments, tax, shipping,
> discounts, entitlements, reporting, and settings (the magic-link email needs the email API
> and a sign-in page URL, §3 Email). The reference **storefront** covers
> catalog, cart and **card checkout**: `/checkout`, the Stripe pay page (`/checkout/pay`) and
> the order confirmation page (`/orders/<orderId>`) are built (ADR-0012), and so are the
> customer account pages (`/account/login`, `/account/verify`, `/account/orders`). Two page
> surfaces are not built yet: the x402 payment gate and the download delivery page (both still
> under issue #27). Deploying today gives you a browsable catalog, carts with real inventory
> holds, magic-link customer accounts, and a Stripe card purchase end-to-end once Stripe is
> configured (§3). When #27 closes, this banner shrinks to a version note.

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
   there is no service URL to bake in; the optional email and x402 provider URLs are read
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
   Admin › Content Types, which in EmDash 0.38 cannot attach the cards to a field: a JSON field
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

### 2.4 The `global_fetch_strictly_public` pairing invariant

> The site's `wrangler.jsonc` carries the `global_fetch_strictly_public` compatibility flag.
> That flag silently breaks the D1 Sessions API — its internal routing request is blocked and
> **every SSR request hangs with nothing in the logs** — so `d1()` in the site config must
> keep `session` **off** while the flag is present. Both halves are pinned by tests:
> `sites/staging/test/site-config.test.ts` (session stays off, placeholder equality) and
> `sites/staging/test/wrangler-config.test.ts` (flag presence, template hygiene). Do not
> "fix" one side without the other.
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
| Email API key + from-address (with the `EMAIL_API_URL` build-time value, §4) | admin Settings (from-address in `settings:emailFrom`) | optional | when wiring real email |

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

> **Live Stripe is TWO-DECIMAL currencies only.** Otta stores money as integer minor units
> at hundredths scale everywhere, while Stripe expects `amount` in each currency's own
> smallest unit. For **zero-decimal** currencies (JPY, KRW, CLP, VND, BIF, DJF, GNF, KMF,
> MGA, PYG, RWF, UGX, VUV, XAF, XOF, XPF) that would charge the buyer **100×**, and for
> **three-decimal** ones (BHD, JOD, KWD, OMR, TND) it is the mirror error — so the live
> `createIntent` **refuses them before any network call** with `PAYMENT_INTENT_FAILED`
> (provider code `unsupported_currency`). Do not price a catalog in those currencies on a
> deployment that takes Stripe payments. Lifting this needs an exponent-aware money
> boundary, not an adapter tweak — the deny-list is `STRIPE_UNSUPPORTED_CURRENCIES` in
> `packages/payments-stripe/src/index.ts`.

> **x402 settles against a real facilitator over `ctx.http`.** The configured facilitator
> credential goes **on the wire** as `Authorization: Bearer …` to the facilitator host, so
> provision a credential that was minted to be sent. The facilitator host must be in the
> plugin's `allowedHosts` — it is seeded at **build** time from the site's Astro config, not
> from `kv`, so changing facilitators is a rebuild, not a settings edit. The pay-to address
> and the accepted-networks list (default `eip155:8453`) are configuration, not credentials,
> and live alongside it in Settings.

- **Email** — with no email API URL baked in at build time there is **no sender at all**:
  nothing is logged or delivered, and the cron sweep's `order-emails` leg reports `skipped`
  rather than draining the outbox (`packages/plugin/src/email/ctx-http-email-sender.ts`).
  With a sender, a settled payment's **order confirmation goes out inline** from the settle
  route, and an admin's status move, fulfilment, cancel or refund sends its email inline from
  the console write (best-effort, a few seconds at most); the `order-emails` leg is the backstop
  that delivers anything those attempts missed, on its next run
  ([ADR-0005](./adr/0005-transactional-email-transport.md), 2026-10-02;
  [ADR-0026](./adr/0026-admin-order-actions-never-claim-money-that-did-not-move.md)). With no
  sender the console says so on every such write instead of claiming the buyer was emailed.
  Only the API URL is build-time (`EMAIL_API_URL`, §4 — it also seeds `allowedHosts`); the
  API key is a write-only Settings credential, and the from-address ("Order email
  from-address", `settings:emailFrom`) is a readable Settings field. Unset, it falls back to
  `no-reply@otta.local` — a dev-only default that a local mail catcher accepts and no real
  provider will send from. The Settings save refuses a from-address that is malformed,
  carries a control character, has an IP-literal or single-label domain, or sits under a
  reserved name: `.local`, `.localhost`, `.test`, `.example`, `.invalid`, `.internal`,
  `.onion`, `.alt`, `example.com` / `.net` / `.org` or `home.arpa`. An internationalized
  domain is entered in its `xn--` form. A from-address saved before this release that the
  check refuses (e.g. a reserved domain, an unquoted comma in the name, an IP literal or a
  Unicode domain) still sends, and is logged once per isolate (`settings:emailFrom is not a
  deliverable address`); it must be fixed or cleared before the payment settings form will
  save again. **Magic-link login mail** goes out through the same sender, and only once Settings
  → "Sign-in page address" (`settings:loginLinkUrl`) holds the absolute URL of the storefront's
  `/account/verify` page — the emailed link points there and never at the request's origin.
  The save requires `https://` (plain `http://` only for `localhost`, `127.0.0.1` or `[::1]`),
  because the link carries a sign-in token.
  With no email API URL or no sign-in page URL, `requestLoginLink` answers the same generic
  success, issues nothing, and logs once server-side. For the reference site, set it to
  `https://<your-site>/account/verify`. **Order emails link to the order page** through the
  same setting: its origin plus `/orders/<order id>`, the page a shopper is sent to after
  checkout (a bearer link — anyone holding it sees the order's public view, which carries no
  address or email). Two assumptions: the storefront is served from the **root** of that
  origin (a path on the sign-in page URL, such as `/shop/account/verify`, is dropped — the
  site's own links are root-absolute), and the URL is **https**. An `http:` URL is used only
  for `localhost`, `127.0.0.1` or `[::1]` (local development); any other http URL gives no
  order link, because a bearer link must not travel in clear text. Unset or invalid, order
  emails go out with no link; it is never taken from a request's `Host`. The sign-in email (and the sign-off of every order email) names the
  store from Settings → "Store display name" (`settings:storeDisplayName`); unset, it is
  left out. The sign-in email states the link's real lifetime (15 minutes). Order
  emails list the order's own line snapshot, totals and ship-to, with money formatted as the
  storefront formats it.

> **Email provider: Resend.** The sender posts Resend's `POST /emails` body exactly (bearer
> auth, `Idempotency-Key` = the outbox row id, the template name as a `template` tag), so
> Resend is the supported provider. To reach real inboxes:
>
> 1. Build with `EMAIL_API_URL=https://api.resend.com/emails` (§4 — this also grants
>    `api.resend.com` in `allowedHosts`).
> 2. Add and verify your sending domain in Resend (its SPF and DKIM DNS records); a DMARC
>    record with `p=none` is recommended to start. Without a verified domain Resend only sends
>    from `onboarding@resend.dev`, and only to the Resend account owner's own address.
> 3. In admin Settings, save the Resend API key (it starts `re_`; with Resend configured the
>    save refuses any other shape) and a from-address on that verified domain —
>    `orders@yourdomain.com` or `Your Shop <orders@yourdomain.com>`.
> 4. Set "Sign-in page address" to the public `https://<your-site>/account/verify` URL — a
>    localhost or http URL in a customer's inbox is a dead link. Order emails link to
>    `https://<your-site>/orders/<id>` from the same setting, and set "Store display name"
>    so the sign-in email names your store.
>
> Resend's free tier is 3,000 emails/month and 100/day. A refused send throws with Resend's
> own error name and message (never the request). **Only the login route logs it today**:
> a refused order email is retried and eventually parked `failed` in the outbox with no log
> line, so check Resend's dashboard when order mail goes missing. Resend's testing-mode
> refusal quotes the account owner's address, which can therefore appear in that log.
>
> Resend dedupes on `Idempotency-Key` for 24 hours, and answers **409** when a retry reuses
> a key with a *different* body — for example after the from-address was changed while a row
> was waiting to be retried. Such a row is refused on every retry and parks as `failed`.
>
> Another provider needs its own adapter behind the `EmailSender` port; pointing
> `EMAIL_API_URL` at a non-Resend API is not supported.

## 4. Egress and `allowedHosts`

The plugin's only egress is `ctx.http.fetch`, gated by the descriptor's `allowedHosts`
allowlist (capability `network:request`). That allowlist is resolved at **build** time
(`packages/plugin/src/manifest.ts`, fed by `sites/staging/astro.config.ts`) and contains:

| Host | When |
|---|---|
| `api.stripe.com` | always — the one constant entry |
| the email API host | when an email API URL is configured |
| the x402 facilitator host | when a facilitator URL is configured |

The two URLs are `EMAIL_API_URL` and `X402_FACILITATOR_URL`, read by
`sites/staging/astro.config.ts` from `process.env`, falling back to `sites/staging/.env`.
Set them in the shell or in `sites/staging/.env` **before** building (§2.1 step 4); unset,
the provider is simply unconfigured and no host is granted for it.

Stripe traffic goes through the same gate: `@otta-sh/payments-stripe` would default its
transport to `globalThis.fetch`, but the plugin constructs the live gateway with
`ctx.http.fetch` (`packages/plugin/src/payments/stripe-wiring.ts`), like the email sender and
the x402 facilitator client — so the allowlist is the perimeter for `api.stripe.com` too. This
closes the caveat recorded in
[ADR-0020](./adr/0020-one-deployable-plugin-owns-commerce-truth.md) §2.

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
sandboxed path EmDash's bridge answers `null` for any D1 error. So a run first checks that the
CMS lists at least one product, and judges nothing otherwise. A page on which at least three, and
more than half, of the products read are missing is abandoned as an outage. That breaker needs
three rows read, so on the Workers Free preset's first pass (pages of one or two rows) it fires
only on a second pass; there the other gates do the work. A missing document is re-read twice on
the spot, and counts as a strike only in a run that read some other document successfully (if
nothing on the page was found, the run reads the product the list returned; a `null` there is
treated as an outage). The row is tombstoned on the third strike, each from a run at least
fifteen minutes after the last, and any read that finds the document wipes its strikes. Every
breaker trip wipes all strikes. On top of that: at most five tombstones a minute, a failed read
never counts, and rows younger than fifteen minutes are not read. Each of those stops logs a
`cron sweep product-orphans` error line. A pass over a 1000-product catalog takes about 280
ticks (under five hours) on the Workers Free preset when the store is otherwise idle, and about 7
on Paid; an orphan is tombstoned on the third pass that finds it, so up to about three rotations
on Free. The leg has no deadline, so it is never promoted ahead of other legs by aging. **The
residual risk on a sandboxed host:** a CMS database failing reads at random is
indistinguishable from deletions. A seeded simulation (40 live products, 360 one-minute ticks,
every read independently failing to `null`) tombstones none at failure rates up to 30%. At a
sustained 50% for six hours, on the Paid preset, it struck out 2 of 40. The tombstone is
final, so a live product struck out that way sells again only once it is duplicated in the CMS
(a new id, and its pricing re-entered). The outbox, the two expiry legs, the
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

**Order emails: a timeout is retried later, and only counts once it keeps happening.** Each send
gets at most 5 s, or what is left of the outbox's share of the tick, whichever is sooner — and
that limit covers the whole send, including the host resolving the provider's address; 5 s is
long enough for a slow-but-working provider to deliver. Just before sending, the sweep checks the
time again (the claim and the order reads take time of their own); with too little left it hands
the email back untried, due again in 30 s (so a short tick cannot keep one email at the head of
the queue). A send the tick had to give **less** than the full 5 s and that then times out is
the sweep's doing, not the provider's: it is handed back due at once, uncounted, with nothing
recorded against it. A send that **times out with the full 5 s** is handed back **without
counting an attempt** and backed off — retried after 1 minute, then 2, 4, 8, up to 15 — so it moves
behind other queued emails instead of holding the head of the queue; if the provider did deliver
after all, the retry carries the same `Idempotency-Key` and the provider dedupes it. After **ten**
timeouts on one email the sweep logs `[otta] cron sweep order-emails: the email provider has
timed out N times …` with `console.error` (alert on it), and from then on each timeout counts as
a failed attempt, so the email is eventually parked `failed` with the reason "provider kept
timing out". A genuine provider failure (a non-2xx answer or a network error) always counts, and
an email is parked `failed` after five attempts. There is
no admin action to re-queue a parked email yet (a follow-up); until there is, a parked
email is a provider or configuration problem to fix at the provider, and the customer will not
receive that message.

**The plan this assumes.** Cloudflare caps one Worker invocation at **50 D1 queries and 50
subrequests on Workers Free** (1000 queries and 10,000 subrequests on Workers Paid; see
Cloudflare's [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). The scheduled event
that runs the sweep also runs EmDash's own executor, scheduled publishing, cleanup and heartbeat,
so by default the sweep keeps itself to 30. Measured on the document store (each storage or kv
call counted once, `cron-leg-costs.test.ts`): an idle tick is **8 queries**; a tick where the
scans come due adds about 17–20 more; one email is about **12** (the claim, the order, the
sender's key and from-address reads, the request, marking it sent), one hold expired about
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

## 6. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Every SSR request hangs, nothing in logs | `global_fetch_strictly_public` + D1 `session` both on — pairing invariant violated (§2.4); turn `session` off |
| `/products` empty right after deploy | Healthy (§1) — sample content lands via the wizard checkbox, not first boot |
| `POST /webhooks/stripe` reports `NOT_CONFIGURED` | The Stripe webhook signing secret is unset — provision it in admin Settings (§3) |
| Every Stripe delivery 401s | `OTTA_WH_TOKEN` set on the plugin side but not on the site (or the values differ) — §3 |
| An expired order is flagged `late payment … needs checking (…) — verify in Stripe` | A buyer paid after expiry and the automatic refund's outcome is unknown — most often a refund create that hit the settle path's 3 s timeout (the price of answering Stripe inside its delivery window: a timed-out create may still have been processed, so it is held `unverified` rather than retried blind) — or Stripe already shows it refunded, or the retries gave up after ~3 days. Check the PaymentIntent in Stripe before refunding again, then resolve the flag in the admin console |
| An expired order is flagged `late payment … automatic refund failed (…) — refund it manually` | Stripe definitively refused the automatic refund (or it would exceed the order total). Refund in Stripe or the admin console, then resolve the flag |
| An expired order is flagged `settle on expired` and nothing was refunded | The Stripe secret key is not set (so the settle route cannot refund), or it is a cancelled order with no audit evidence it was unpaid — refund in Stripe and resolve the flag |
| Sweeps never run | Nothing has bootstrapped the schedule, or the runtime wired no cron executor — check that the site's Cron Trigger is present and load `/products` or a product page once (§5) |
| An outbound call to Stripe / the email provider / the x402 facilitator never leaves | The host is not in the build-time `allowedHosts` allowlist (§4) — rebuild and redeploy |
