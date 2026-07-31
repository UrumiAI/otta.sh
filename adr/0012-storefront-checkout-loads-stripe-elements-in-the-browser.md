# 0012. The storefront checkout loads Stripe Elements in the buyer's browser

- Status: accepted
- Date: 2026-07-27
- Amended: 2026-07-28 — decision 2's fence widened by exactly one component; see
  "Amendment (2026-07-28)" under Decision.

## Context

The buyer journey dead-ends at `/cart`: `GET /checkout` is a themed 404, and nothing in the
repo consumes the `stripe_client_secret` that `POST /checkout/orders` already returns
(`packages/service/src/routes/orders.ts`, `payments-stripe/src/index.ts`). Everything
server-side is built and proven — quote, order creation, real test-mode PaymentIntents, the
`payment_intent.succeeded` webhook, `settleOrder`. The missing leg is the buyer-facing one.

Two prior decisions already cover most of the shape, and this record does **not** re-open
them:

- **ADR-0003 §5** pre-authorizes the page shape verbatim — "checkout/confirmation pages
  follow the same pattern: public plugin route owns the view model and orchestration; a theme
  page renders it. No new architecture arrives in Phase 4 for this."
- **ADR-0009** decided the shipping-address capture and names this UI as its slice (c),
  "storefront checkout UI collects it".

What is *not* covered is the part that changes a stated property of the whole storefront.
ADR-0003's posture is a **thin theme layer whose pages are fully server-rendered**, and the
site has honoured that literally: five pages, one layout, **zero lines of client JavaScript**
and **zero third-party origins**. The only `<script>` anywhere is
`products/[slug].astro`'s `type="application/ld+json"` — data, not code.

Card entry cannot preserve that. Collecting a PAN on our own origin would move the deployment
from PCI SAQ-A (redirect/iframe: the card number never touches our servers) to SAQ-D (we
handle card data), a categorically different compliance obligation for every merchant who
deploys this theme. Stripe's supported integrations all put the card field in Stripe's own
frame, and every one of them needs either their JavaScript or their hosted page.

So the decision is not "JS or no JS" — it is *which* way we give up the zero-JS property.

### Alternative considered and rejected: Stripe hosted Checkout (redirect)

`POST /v1/checkout/sessions` returns a URL; we `303` the buyer to a page Stripe hosts and
Stripe redirects back. This **preserves zero client JS on our origin entirely** and is a
genuine option, not a straw man. It is rejected because:

1. **We lose the page.** Totals, honest "shipping is not calculated" copy (§ below), line
   items, branding, and the "Start a new cart" recovery affordance would all be replaced by
   Stripe's page, which knows nothing about our cart, our order, or our recovery states. The
   thing we are building *is* a checkout page.
2. **Order creation would have to move or double.** Our order (with its 15-minute stock hold,
   its immutable price snapshot and its idempotency fence) is minted by
   `createOrderFromCart`; a Checkout Session mints Stripe's own line items from its own
   payload. Keeping both in step is a second reconciliation surface next to the one
   `settleOrder` already owns.
3. **It buys less than it looks.** The buyer still leaves our origin and still comes back
   through a redirect with query parameters; we still need the confirmation page, the webhook,
   and the pending→paid rules. The saving is one `<script>` tag, not a class of problem.
4. **Automatic payment methods.** Our live intents already use
   `automatic_payment_methods[enabled]=true` (`payments-stripe/src/index.ts`), which the
   Payment Element renders directly — wallets and local methods appear as Stripe enables them,
   with no further work on our side.

The judgement is that one fenced page of client JS is a smaller and more reversible cost than
handing the checkout page itself to a third party. If that trade ever inverts, hosted Checkout
is a clean superseding ADR — the plugin routes and the confirmation page survive it.

## Decision

**1. Card entry loads `https://js.stripe.com/v3/` in the buyer's browser, on `/checkout/pay`
only.** That page mounts the Payment Element on the client secret returned by
`POST /checkout/orders` and calls `stripe.confirmPayment({ return_url })`. Card data goes
browser → Stripe and never touches our origin (PCI SAQ-A preserved).

**2. The departure is scoped and fenced.** Client JS exists on `/checkout/pay` and nowhere
else; `js.stripe.com` is the only permitted third-party origin; every other page and **every**
mutation stays a server-rendered `<form method="POST">` → 303. A test pins that no other page
under `src/pages/` contains an executable `<script>`
(`sites/staging/test/checkout-client-js.test.ts`). Exactly one step of the six-step buyer
journey degrades without JS, and it degrades to a linked, recoverable `<noscript>` state that
names the order and its 15-minute hold — not a broken form.

  ### Amendment (2026-07-28): the cart's hold countdown is the second, and last, exception

  **What changed and why.** This ADR is dated 2026-07-27. `docs/theme/TEMPERED.md` — the
  "Tempered" theme spec — **postdates it**, and its §6 makes the hold ribbon the storefront's
  signature element with a requirement this decision did not anticipate: *"The countdown is
  **information, so it ticks even under `prefers-reduced-motion`** — that media query
  suppresses decorative motion, not a timer the shopper is relying on."* A ticking countdown
  is client JavaScript. A server-rendered `08:32` is true for one second and then quietly
  lies to a shopper who is deciding whether they have time to finish, which is worse than
  either alternative. The `<noscript>` fallback renders the absolute expiry instead, so the
  no-JS path still tells the truth — it just cannot count.

  **The amended fence.** Client JS is permitted on:

  1. `/checkout/pay` — Stripe Elements (decision 1);
  2. `/cart` — and only through `HoldRibbon.astro`, whose ~15 lines drive the §6 countdown.

  Nowhere else, and nothing else. Every other page and **every** mutation stays a
  server-rendered `<form method="POST">` → 303.

  **What the test now checks**, which is more than it did before. The original fence read each
  page's own source for an executable `<script>`. That missed the way client JS actually
  arrives in a component-based theme: `/orders/<id>` shipped `HoldRibbon`'s countdown module
  for a while purely by importing the component, with its own source spotlessly clean. The
  fence now walks each page's `.astro` imports **transitively** and fails on any browser code
  — `<script>` or a `client:*` directive — reaching a page that is specified to have none. The
  two permitted routes above are a **named allowlist** in that test, so widening the set stays
  a decision someone has to write down rather than a diff nobody notices. The check is an
  **equality**, not a subset: an entry whose page stopped importing the component would
  otherwise rot open, pre-approving a pair nobody uses, so an unearned permission fails the
  suite exactly like an unpermitted route does.

  **What did NOT change.** `js.stripe.com` remains the only third-party origin — the countdown
  is first-party code, bundled by Astro and served from our origin. `allowedHosts` is
  untouched (decision 3). The confirmation page is back to **zero** client JS, which is why
  `PollRibbon.astro` exists at all: it is the same ribbon running indeterminate, as pure CSS,
  so the pending sweep costs the page nothing.

**3. `allowedHosts` does not change, and must not.** `allowedHosts` gates `ctx.http.fetch` —
*server-side plugin egress only* (`manifest.ts`, `otta-plugin-descriptor.ts`). Stripe.js is
fetched and called **by the buyer's browser**, which never passes through the plugin. Adding
`js.stripe.com` there would be both useless and a real widening of the gate ADR-0006 exists to
keep at exactly one host. A test asserts `js.stripe.com`'s **absence** from `ALLOWED_HOSTS`,
so a future "we talk to Stripe now, so add it" edit fails loudly.

**4. The publishable key is a build-time bake, and the variable is `STRIPE_PUBLIC_KEY`.**
It is read at build time by `sites/staging/astro.config.ts` (shell env → `sites/staging/.env`
→ absent) and baked via a second Vite `define`, exactly like `COMMERCE_SERVICE_URL`. Changing
it is a rebuild + redeploy. Its **absence** degrades honestly: `/checkout` renders review and
totals but replaces "Continue to payment" with "Card payment isn't set up on this store yet."
and creates **no** order.

  The variable is **`STRIPE_PUBLIC_KEY`** — not `STRIPE_PUBLISHABLE_KEY`, which appears
  nowhere in our provisioning. This is named exactly because the honest-degradation path is
  *indistinguishable at runtime from a misspelt variable name*: both render "isn't set up"
  while a valid key sits unread, and nothing errors. Two guards make that class of
  misconfiguration loud: the resolver **throws at build time** on a present-but-malformed
  value (mirroring `resolveServiceUrl`'s "throw early rather than bake garbage"), and a test
  pins the literal variable name as data.

  The key is deliberately baked rather than read from wrangler `vars` at runtime:
  `sites/staging/test/wrangler-config.test.ts` forbids any `vars` key matching
  `/SECRET|KEY|TOKEN|PASSWORD/i`, and a publishable key — though not a secret — matches that
  pattern. Keep the guard; bake the key.

**5. The confirmation page never claims "paid" on the strength of a redirect.** Stripe appends
`redirect_status=succeeded` to `return_url`; that is the *buyer's browser* reporting what
Stripe told it. The order becomes `paid` only through `settleOrder`'s guarded `pending → paid`
flip, driven by the `payment_intent.succeeded` webhook after an amount+currency equality check
— the sole authority. `/orders/<id>` re-reads the order from the service and renders **the
order's own state**, using the redirect parameters for *one* purpose only: choosing between
two `pending` copy variants ("payment submitted, confirming…" vs "awaiting payment"). While
`pending`, it polls with a bounded `<meta http-equiv="refresh">` (8 refreshes, ≈30 s) and then
offers a manual "Check again" link. No JS, no busy loop.

**6. The client secret reaches a URL bar regardless, and we accept that.** The `otta_checkout`
cookie (`httpOnly`, `secure`, `SameSite=Lax`, `path=/`, 15-minute `maxAge`) keeps the client
secret out of *our* URLs on the site→`/checkout/pay` leg — the leg we control, and the one
where a secret in a query string gets bookmarked and pasted into support tickets. **It does
not keep the client secret out of URLs generally.** Stripe's Payment Element redirect appends
`payment_intent_client_secret` (plus `payment_intent`, `redirect_status`) to our `return_url`,
so one hop later the secret lands in browser history, in the `Referer` of any subresource on
the confirmation page, and in Cloudflare's access logs. That is Stripe's wire format and is
not ours to change.

  The mitigations that *are* ours, all of them implemented and tested: the confirmation page
  carries `<meta name="referrer" content="no-referrer">`; the three parameters are never
  echoed into markup (asserted structurally — they may appear only in the Astro frontmatter,
  never in the template body); they are never forwarded upstream; and they never decide that
  anything is paid. A client secret is scoped to one PaymentIntent and confers no account
  access, so the residual exposure is bounded — but it is real, and it is recorded here so a
  future reviewer who finds one in an access log knows nothing regressed.

**PR tagging.** This ships tagged `[Plugin]`, reading CLAUDE.md's "the EmDash plugin
(storefront, …)" scope as covering `sites/staging` — the site is the theme-shim half of the
plugin's storefront surface (ADR-0003). Neither `@otta-sh/service` nor `@otta-sh/domain` changes.

## Consequences

**Easier**

- The buyer journey completes: cart → review → pay → confirmation, against real Stripe
  test-mode intents.
- Wallets and local payment methods arrive for free through `automatic_payment_methods`.
- The checkout page stays ours: honest totals, real recovery states, our copy.
- The plugin's egress story is unchanged — still one allowed host, still no new capability.

**Harder**

- "The storefront ships zero client JS" is no longer true, and the claim now needs the
  qualifier "outside `/checkout/pay` **and the cart's hold countdown**" (amended 2026-07-28).
  The fence is a test, not a convention, precisely because the property is otherwise easy to
  erode one page at a time — and the amendment is the proof: the second exception arrived from
  a *design spec written after this record*, not from anyone deciding to relax the rule.
  Two exceptions in two increments is the rate worth watching; a third should be a superseding
  ADR rather than a third allowlist entry.
- The fence's unit is now the **page plus its component closure**, not the page file. That is
  strictly harder to satisfy and strictly more honest: a component's `<script>` ships wherever
  the component renders, so a shared component is a shared client-JS decision. It is also why
  a component may need to be split rather than parameterised — `PollRibbon` is `HoldRibbon`
  minus the countdown, and exists only so the confirmation page can have the ribbon without
  the module.
- A third-party origin is now load-bearing for revenue: `js.stripe.com` being unreachable
  breaks card entry. The page catches Elements' own failure and says so honestly (including
  for the offline-mode fake client secret a service without `STRIPE_SECRET_KEY` mints), rather
  than rendering a blank frame.
- Any future CSP must allow `https://js.stripe.com` for scripts and Stripe's frame origins —
  a constraint that did not exist before.
- Browser QA is now part of "done" for this surface: `.astro` files are pinned by source-text
  assertions only (no render harness exists — issue #40), so the client JS is verified by
  driving a real browser.

**Accepted**

- The client secret's exposure in history / `Referer` / access logs after Stripe's redirect
  (decision 6), bounded by its single-intent scope and the mitigations listed there.
- An unsupported-currency failure is indistinguishable from a Stripe outage at the page:
  `providerCode: "unsupported_currency"` is log-only and never on the wire. The copy ("We
  couldn't start a payment for this order. No charge was made.") is true either way. A
  pre-flight currency check would require the deny-list from `@otta-sh/payments-stripe`, i.e. a
  new plugin dependency — worth doing only if a non-two-decimal catalog is ever planned.
- Stripe expires idempotency keys after ~24 h, so a retry past that window mints a second
  PaymentIntent. Both carry the same `metadata[order_id]` and settlement dedupes on event id.
