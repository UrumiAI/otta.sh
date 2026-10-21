# @urumi.ai/otta-site-staging

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
pnpm --filter @urumi.ai/otta-site-staging dev
```

Nothing else has to be running: commerce is **in-process** in this site's own Worker
(ADR-0006), so there is no second process to start and no service URL to point at.

In `astro dev` the fastest path to a populated catalog is the dev-only bypass, which
applies the full seed including the 3 sample products:
`/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`. What first boot does and does
not seed in a real deployment is covered in [`DEPLOYMENT.md`](../../DEPLOYMENT.md) §2.2.

### Plugin settings are namespaced by plugin id

A setting saved under one plugin id is not visible to another. The Block Kit screens and the
React console both read `otta`'s.

### Running the stack from a non-interactive shell (agents, CI sandboxes)

`astro dev` is a long-running foreground process: started in the usual way it holds the
terminal and never returns. In an automated or agent-driven environment, start it **detached**
and wait until it reports its URL before driving it — a request issued before the server is
listening fails in a way that looks like an application error.

## The Stripe publishable key (a Settings value)

The checkout's Payment Element needs a Stripe **publishable** key. It is entered in the admin
with the two Stripe secrets — **Otta Store settings → General → Payments & email → Stripe publishable key** —
and the checkout pages read it **per request** (`src/lib/stripe-config.ts`, through the
plugin's `storefront/payment-config` route). Changing it needs no rebuild, redeploy or
restart (issue #498; it used to be the build-time `STRIPE_PUBLIC_KEY`).

| Publishable key | What happens |
|---|---|
| a valid `pk_test_…` / `pk_live_…` | full checkout: review → pay → confirmation |
| **not set** (or a Stripe secret is missing) | `/checkout` renders review + totals, says "Card payment isn't set up on this store yet.", and creates **no order** (the endpoint refuses too, not just the button) |
| not a `pk_…` key | refused on save in Settings; a value stored some other way reads as **not set**, and Settings says why |
| the read failed (storage busy) | answered as **busy** (503 / `?error=BUSY`), never as "not set up" |

The last row is what the old build check protected: a key that exists but cannot be read
must not look like a store that takes no cards. Settings also warns when the publishable
key's mode (test/live) differs from the secret key's. A build that still sets
`STRIPE_PUBLIC_KEY` **fails**, saying where the key goes now. See
[ADR-0012](../../adr/0012-storefront-checkout-loads-stripe-elements-in-the-browser.md).

Card checkout is offered only when **all three** Stripe values are saved and usable: the
publishable key, the secret key and the webhook signing secret (issue #499). The Payments &
email group in Settings starts with one line, "Card payments: ready" or "not ready (missing: …)".
A place that reaches the server without a gateway is refused the same way, and the server
log names the missing value.

## Test card payments locally

Stripe can't reach `localhost`, so in local dev no webhook arrives and a paid order stays at
"Payment submitted.". The Stripe CLI forwards them:

1. Save your Stripe **test** secret key (`sk_test_…`) and publishable key (`pk_test_…`) in
   **Store settings → General → Payments & email**.
2. In a second terminal, with the dev server running:

   ```bash
   stripe listen --events payment_intent.succeeded,payment_intent.payment_failed \
     --forward-to localhost:4321/webhooks/stripe
   ```

3. It prints `Your webhook signing secret is whsec_…`. Save **that** value as the Stripe
   webhook signing secret. A Dashboard endpoint's secret (Developers → Webhooks) doesn't
   apply here. The CLI keeps the same secret across restarts for the same account.
4. Settings should now say "Card payments: ready.". Check out with test card
   `4242 4242 4242 4242`, any future expiry, any CVC and any postal code. The order page
   says "Order confirmed." once the forwarded `payment_intent.succeeded` lands.

A confirmation missed while `stripe listen` wasn't running can be sent again: take the event id
(`evt_…`) from the Dashboard (Developers → Events) or the CLI output and run
`stripe events resend <evt_id>` while `stripe listen` is forwarding.

## Deploying

The deploy runbook for this site lives in the root [`DEPLOYMENT.md`](../../DEPLOYMENT.md):
resource creation, the build/deploy ordering, first boot + claim, and failed-first-boot
recovery are §2; why D1 `session` is `"primary-first"` (not `"auto"`), and why
`global_fetch_strictly_public` must never return beside it, are §2.4; the secrets & tokens
checklist is §3. There is one deployable, so the only Worker secrets are
`EMDASH_ENCRYPTION_KEY` (required before first boot) and the optional `OTTA_WH_TOKEN` webhook
edge gate — every payment and email credential is provisioned in the
admin console's **Store settings** page (General tab) instead.

## Notes

- **The checkout is built** (ADR-0012): `/checkout` (review + honest totals + contact and
  ship-to), `POST /checkout/place`, `/checkout/pay` (the Payment Element — the site's only
  third-party script, `js.stripe.com` its only third-party origin; the one other client
  script is the hold ribbon's countdown, `src/components/HoldClock.astro`, rendered by
  `/cart` alone — the ribbon's markup, `HoldRibbon.astro`, carries none), and
  `/orders/<orderId>` (the capability-URL confirmation page, which polls with a bounded
  `<meta http-equiv="refresh">` and never claims "paid" on the strength of Stripe's
  redirect — the webhook is the sole authority). `POST /checkout/new-cart` is the way out
  of the dead-cart trap. `allowedHosts` is unchanged: browser→Stripe is not plugin egress.
- **Digital downloads (issue #376).** `GET /orders/<orderId>/download/<sku>`
  (`src/pages/orders/[orderId]/download/[sku].ts`, logic in `src/lib/download-delivery.ts`)
  streams a paid file from the private `DOWNLOADS` R2 bucket. On every request it first asks
  the plugin's `entitlements/download` gate in-process with `{orderId, sku}`; the gate
  answers the file only for an active grant on a deliverable order of a digital product with
  a file attached. The endpoint reads only the key the gate answers, never one from the
  request. The order id in the path is the capability (ADR-0011, as amended), so the gate
  is not an oracle: every refusal is the same 404, and a caller without the order id learns
  nothing. Nothing is minted or cached, so a full refund closes the URL at once, and a
  replaced file serves the new one. Range requests get 206/416; BUSY is 503 + `Retry-After`.
  `/orders/<id>` and `/account/orders/<id>` show a Download link on each digital line the
  gate authorizes (`src/lib/download-links.ts`). The middleware refuses EmDash's public media
  route for any `dl/` key (`src/lib/media-deny.ts`), and the build refuses a wrangler config
  whose `DOWNLOADS` is the `MEDIA` bucket (`src/lib/downloads-bucket.ts`; DEPLOYMENT.md
  §2.1). The merchant attaches the file in the product editor's **Download file** card
  (`@urumi.ai/otta-admin-react`, `packages/admin-react/src/products/download-file-card.tsx`).
- **Customer account pages (issue #306, ADR-0004).** Magic-link sign-in:
  `/account/login` (email form → `POST /account/login/request` → the same generic
  "check your inbox" notice for every address), `/account/verify` (where the
  emailed link lands — it renders a button and redeems NOTHING on the GET, so a
  mail scanner's pre-fetch cannot spend the single-use token; `POST
  /account/verify/confirm` redeems it and applies the plugin's session-cookie
  descriptor verbatim, HttpOnly/Secure/SameSite=Lax), `/account/orders` and
  `/account/orders/<id>` (read through the session; guest orders under the same
  address are claimed at sign-in), and `POST /account/logout` (revokes server-side,
  always clears the cookie). Every POST runs the origin guard first; account pages
  are `private, no-store`. The header carries a theme-owned "Account" link unless the
  CMS menu already links into `/account`. Saved addresses
  (`storefront/account/addresses`) have no page yet.
  **Operator setup, required for sign-in:** in the plugin's Settings, set **Sign-in page
  address** (`settings:loginLinkUrl`) to this site's absolute verify URL, e.g.
  `https://shop.example/account/verify`. The emailed link points there and nowhere else.
  The request's origin is never used, because a spoofed `Host` could otherwise aim a
  victim's link at another domain. While the setting is unset, the login form still
  shows its generic notice but no link is sent, and the plugin logs that once.
- No secrets anywhere in this package: `.env` is gitignored, `.env.example` holds
  placeholders, `wrangler.jsonc` `vars` must never grow a secret-shaped key (pinned by
  `test/wrangler-config.test.ts`).
