# 0012. The storefront checkout loads Stripe Elements in the buyer's browser

- Status: accepted
- Date: 2026-07-27
- Amended: 2026-07-28 — decision 2's fence widened by exactly one component; see
  "Amendment (2026-07-28)" under Decision; clarified 2026-09-30 (HoldClock rename).
- Amended: 2026-10-02 — `/checkout/pay` reads the order's state before mounting the card form,
  and decision 5's use of the redirect parameters covers a lapsed pending order; see
  "Amended 2026-10-02" at the end of this record.

- Amended: 2026-10-02 (second) — the order page resumes a pending order's payment on any
  device through `/checkout/resume`, and a refused checkout keeps the typed values in a
  first-party draft cookie; see "Amended 2026-10-02 (second)" at the end of this record.
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
     (2026-09-30: the same script, renamed not widened — it now lives alone in
     `HoldClock.astro`, split from the ribbon's markup so each storefront theme's cart view
     can draw its own ribbon while `/cart` itself renders the one script; see ADR-0024.
     The fence's pair is `cart/index.astro → HoldClock.astro`.)

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

  (2026-10-02) One more is ours and is now in place: `/checkout/pay`, whose HTML carries the
  client secret, is sent `Cache-Control: private, no-store` and kept out of Astro's route
  cache (`keepPrivate`, `sites/staging/src/lib/no-store.ts`), as are the cart, review and
  confirmation pages — so no shared cache stores the secret. It does not reach the URL-bar
  exposure above, and a browser's back/forward cache is not guaranteed to honour it.

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

## Amended 2026-10-02 — the pay page checks the order can still be paid

**What changed and why.** `/checkout/pay` rendered the card form from the `otta_checkout` stash
alone and made no commerce call. The stash outlives the order's hold, and a client secret stays
payable at Stripe until something withdraws it — so a buyer who kept the tab open could pay an
order that had already **expired**, for stock already back on sale (ADR-0022's 2026-10-02
amendment, which also adds the server-side prevention and the automatic refund).

**The amendment.**

- `/checkout/pay` now makes exactly one commerce call, a READ: the same public, capability-scoped
  `storefront/order` route the confirmation page uses. An order that is not `pending`, or whose
  `holdExpiresAt` has passed, or that the read says does not exist, is redirected (303) to its
  confirmation page instead of getting a form (`sites/staging/src/lib/pay-guard.ts`). An
  UNKNOWN answer — dispatch failed, BUSY, a render-guard failure — still renders the form: the
  server cancels an expired order's intent and refunds a payment that lands anyway, so the page
  is defence in depth and must not turn a storage hiccup into a checkout outage. The amount on
  the button still comes from the stash, never from this read.
- Decision 5 is widened by one clause: the redirect parameters still only choose how a `pending`
  order is presented, and that now includes a pending order **past its hold**. Arriving without
  them, it says "The time to pay has run out. If you already paid, this page will update — if
  the order has already expired by then, it will be refunded." — it claims nothing about stock
  or charges,
  because the order is still pending, and nothing about who refunds, because on some paths a
  person does — keeps the bounded poll, and offers the door out
  instead of a resume link (the pay page would refuse it, so "resume" would be a loop until the
  sweep runs). Arriving with them, it still gets "payment submitted" and the poll, because a
  just-paid pending order may still settle. They are still never rendered, forwarded, or
  trusted to decide that anything is paid.
- The guard's read costs one document read (the plugin reads the order and its ledgers
  together). The `latePayment` derivation riding on it does no I/O and short-circuits for a
  `pending` order — the only state the guard lets through — so the guard pays nothing for it.

## Amended 2026-10-02 (second) — resuming payment from the order page, and keeping typed values

**What changed and why (QA U-2, U-1, U-14).** The order page's "Complete payment" linked to
`/checkout`, which rebuilds the pay step from the CART cookie: a dead end on another device or
once that cookie had rotated. Where it worked, the locked review showed an empty, editable email
that the replayed order silently ignored. Separately, every refused place 303'd back to an empty
form, because the redirect may carry no personal data (decision 6's reasoning).

**The amendment.**

- **Resume.** `GET /checkout/resume?order=<id>` asks the plugin's public `storefront/order/resume`
  for the order's OWN PaymentIntent: the plugin replays the order's original checkout on its own
  idempotency key (its cart, its buyer), so it is the same order and, at Stripe, the same intent —
  never a second of either. It answers only for a `pending` order strictly before its hold
  deadline (the pay guard's rule), and asks the provider nothing otherwise. The endpoint writes the
  ordinary `otta_checkout` stash and 303s to `/checkout/pay`, whose guard is unchanged. It is a
  GET because the order page is `no-referrer` (a POST from it would carry `Origin: null`); it sends
  the cart and session cookies as the proof, and goes to the email page when neither holds. The GET
  is safe to repeat, and a cross-site navigation (`Sec-Fetch-Site: cross-site`) is sent to the
  order page without dispatching, so another site cannot make a browser write the stash.
- **What authorises a resume: the order id PLUS a second factor.** The id alone is the order
  page's bearer capability, and order links sit in mailboxes and browser histories; the client
  secret a resume hands out can retrieve the PaymentIntent with the publishable key — including
  the `shipping` block (name and address) the Stripe adapter sets for physical goods, which the
  public order does not show. So that widening is now gated by possession of one of:
  - **the cart** the order was made from (this browser's cart cookie), or
  - **a signed-in session** whose customer owns the order (the session cookie), or
  - **the order's email**, typed on a small private page (`/checkout/resume/email`) and POSTed
    from it to `/checkout/resume` — same origin, so the origin guard admits it and still refuses
    a cross-site form. The plugin compares it with the order's buyer server-side, trimmed and
    case-folded, through SHA-256 digests with no early exit; a wrong one gets one generic
    sentence ("That email doesn't match this order."). Guesses are throttled per order — 5 per
    15 minutes, counting every email attempt — by the sign-in throttle's own slot window
    (`login_challenge_claims`, `liveSlots`), offered as the `AttemptThrottle` port and
    `EmdashAttemptThrottle` adapter.

  One consequence, stated: anyone holding the order link can SPEND an order's 5 email tries,
  locking the email route for up to 15 minutes. The cart and owning-session routes still work
  through it, and the buyer can always start a new checkout — which creates a SECOND order, while
  the throttled one keeps holding its stock until its own hold expires.

  The plugin enforces this itself (`storefront/order/resume` is public), not only the site. The
  id alone answers `PROOF_REQUIRED` and asks the provider nothing. What the order link already
  implies — whether the order exists and whether it can still be paid — is answered before the
  proof; nothing else is.
- **The order's email** is shown read-only, as a hint (`j•••@g•••.com`): enough for the buyer to
  recognise, no more than the link should reveal. The locked review no longer renders an email
  field or a place form at all; its "Continue to payment" is a link to the resume path, and it
  shows no stale place-time `?error=`.
- **Typed values.** A refused place writes the typed fields to `otta_checkout_draft` (httpOnly,
  Secure, `SameSite=Strict`, `Path=/checkout`, 15 minutes; whitelisted fields only, never the key
  or a client secret), and the review reads them back with the refused field marked. The URL still
  carries only the error token and the non-personal selection. Applying or removing a coupon now
  posts the details form for the same reason.
- **The deadline.** The pay page states the order's own hold deadline from the read its guard
  already makes — relative minutes plus a time with its zone ("until 2:32 pm UTC").

## Amended 2026-10-02 (third) — the confirmation page's poll runs only after Stripe's redirect, and adds no history

**What changed and why.** QA U-13: the bounded poll counted its hops in the URL (`?p=1…8`), so
every hop was a new URL and a new history entry — eight Backs to leave the page — and it ran for
every `pending` order, including one simply awaiting payment, where nothing is about to change.

**The amendment.** Decision 2 stands: the page still carries **zero** client JavaScript.

- The poll runs only while a change is expected: a `pending` order the buyer has just paid for
  (Stripe's redirect parameters present — decision 5's one use of them, which now also picks
  whether the page polls). An order awaiting payment, or past its hold, does not poll; it offers
  "Check again", and its copy no longer promises that the page will update.
- Each hop is `<meta http-equiv="refresh" content="4">` with **no `url=`**. It reloads the same
  URL, which browsers handle as a replacement of the current history entry, not a new one (the
  HTML standard's same-URL rule; checked in Chromium, where `history.length` stays put across
  hops). Reloading the same URL also keeps the redirect parameters across hops, so every hop
  shows the "confirming" copy; the page still never renders, forwards or trusts them.
- With the URL fixed, the hop count lives in a short-lived cookie (`otta_order_poll`:
  `<orderId>/<payment_intent id>:<hop>`, HttpOnly, `SameSite=Lax`, `path=/orders/`, 2 minutes),
  still bounded to 8 hops. Keyed on the intent id (never the client secret) so a second return
  from Stripe within those two minutes gets its full run. "Check again" links to `""` — the same URL — for the same reasons.
- Superseded wording: the 2026-10-02 amendment above says a lapsed pending order "keeps the
  bounded poll" and "this page will update". It no longer polls; its copy now reads "If you
  already paid, check again in a minute — if the order has expired by then, your payment will be
  refunded."

## Amended 2026-10-03 — a second tab is told which email the order has; the order page states refunds

QA round 2 (X2, X3, N7, U-14). The decisions above are unchanged; these are what the pages now
say.

- **A second checkout tab.** The place key is stable per cart, so a second tab's submit replays
  the order the first tab placed, which keeps the email it was placed with. The place route now
  answers `buyerRefHint` (the order's email, masked) and `emailMatches`. When the typed email is
  not the order's, `/checkout/place` does not go on to the pay page: it stashes the order as any
  place does and returns to the locked review with `ORDER_PLACED_OTHER_EMAIL`, which names the
  masked address and offers "Continue to payment" or "Start a new cart". The hint comes from the
  stash place just wrote, and only when it is the locked order's; otherwise the sentence names no
  address. A normal place stashes the hint too, so the fresh pay page states where the
  confirmation goes, as the resume path already did.
- **Refunds on the order page.** The public order read carries `refundedCents`: the order's
  RECORDED refunds, from the same single ledger read as `latePayment`. The page prints "Refunded
  $X" under the total by the account page's own rule (`orderRefundedNote`), and nothing when the
  ledger shows none, so a refund made outside Otta ("Mark refunded", ADR-0026) is the status
  alone. The figure is a sum the buyer was already told by email; no provider reference or
  reconciliation detail reaches the page.
- **The resume email page** reads the order first: an id that names no order gets the order
  page's 404 and sentence and no form; an order that cannot be paid now goes to its own page.
- **The header's cart count** is read on `/checkout` and `/orders/<id>` too (only the pay page is
  left out). Both pages are already private; the read is a server-side dispatch, so nothing
  reaches the order page's URL or a Referer.
