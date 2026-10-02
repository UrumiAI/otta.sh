# 0004. Storefront customer auth is magic-link (behind a two-port split)

- Status: accepted
- Date: 2026-07-11
- Refines: ADR-0001 (the commerce service owns a customer identity separate from EmDash `ctx.users`)

## Context

Phase 5 needs a storefront **customer** identity — separate from EmDash's admin/staff
`ctx.users` — with login, sessions, saved addresses, and order history. component-map.md and
design-decisions.md left the mechanism open (password / magic-link / passkey), noting it "can
mirror `@emdash-cms/auth` patterns" but must be a **separate identity**. The mechanism-specific
part had to be isolated so the rest of the phase (sessions, `/me`, address book, account pages)
could proceed independent of the still-open decision.

## Decision

Ship **magic-link (passwordless email link)** as the v1 mechanism, behind a **two-port split**:

- `CustomerCredentialVerifier` — mechanism-specific (`issueChallenge` / `verifyChallenge`).
- `SessionStore` — mechanism-agnostic (`create` / `validate` / `revoke`), opaque DB-backed
  tokens (not JWT), stored only as a hash.

Everything downstream of `SessionStore.validate` depends **only** on `SessionStore`, never on
the verifier. Sessions are opaque and DB-backed so revocation actually works.

## Consequences

- **No password-storage liability** and no "forgot password" flow before v1 ships; the
  `EmailSender` port exists on day one (login email + status emails share it — see ADR-0005).
- Matches the sandbox constraint (no client-side WebAuthn crypto to test under workerd).
- Swapping to passkey/password later means a new `CustomerCredentialVerifier` adapter and its
  two `/auth/*` routes only — zero changes to sessions, authorization, or account pages.
- A customer without immediate email access can't log in; mitigated by a long-lived session.
- **Abuse limiting (§9 Risk 4, review round H1):** `issueChallenge` enforces a DB-backed
  **per-email window** — at most N unconsumed, unexpired challenges may exist per address
  (default 3); past the cap the request no-ops (no insert, no email) while the HTTP response
  stays byte-identical, so neither account existence nor the throttle itself is an oracle.
  Consumed/expired challenges are pruned on the same internal maintenance tick as the email
  outbox dispatcher, bounding `login_challenges` growth. **Per-IP limiting is deliberately
  deferred to the gateway layer** (reverse proxy / WAF in front of the service, where the true
  client IP is known and limiting is uniform across endpoints) — the domain port stays
  IP-blind; only the per-email window is service code.
- **Guest-order linking** (§9 Risk 3): a successful magic-link login proves inbox ownership, so
  guest orders with a matching `buyer_ref` are claimed automatically at login (case-insensitive
  on `buyer_ref` — checkout stores it verbatim, review round H2). This linkage depends on the
  mechanism proving email ownership — revisit if the mechanism (this ADR) changes to one that
  doesn't (e.g. plain password).

_Accepted 2026-07-11 — signed off by the maintainer (vedanshu@urumi.ai), implemented per the
Phase 5 plan §4 recommendation._

## Amended 2026-09-29 — the per-address throttle is a lockout lever; per-IP limiting is a launch prerequisite

Issue #306 made the magic link actually send, in process: `storefront/account/login/request`
issues the challenge and emails the link through `CtxHttpEmailSender` over `ctx.http`. The
decision above is unchanged. Three consequences it did not state are recorded here.

- **The link's destination is configuration, never the request.** The emailed link is the
  operator's saved sign-in page (`settings:loginLinkUrl`, an absolute http(s) URL with no
  credentials, validated on save and again on send) with the challenge and token appended.
  It is **required**: unset or invalid means no challenge is issued and nothing is sent. The
  answer stays the same generic success, and the server logs once. The request's origin is
  never used. On a host that does not pin `Host`, it would let an attacker request a
  victim's link pointing at the attacker's domain and receive the token on the victim's
  click. Setting and validation adapted from #325 by @stephanedemotte.

- **The per-address window can lock a customer out.** It is keyed on the address alone, and the
  request route is public. Anyone can send three requests for a victim's address every
  challenge lifetime (15 minutes) and hold the window full. The victim's own request then
  no-ops, identically and silently, and no link arrives. Three requests per quarter-hour per
  target is cheap. The domain port stays IP-blind, as decided above, so the fix belongs at the
  gateway. **Per-IP (and per-network) rate limiting on the login-request endpoint, at the
  reverse proxy or WAF in front of the site, is a prerequisite for exposing customer login to
  real customers.** It is no longer an optional hardening. Until it is in place, login should
  be treated as not launch-ready. On Cloudflare, a rate-limiting rule on
  `POST /account/login/request` (and the plugin's public
  `/_emdash/api/plugins/otta/storefront/account/login/request` mount) satisfies this.
- **The response is identical, but its latency is not quite.** A throttled request skips the
  provider round trip, and a sent one waits for it. The send is therefore bounded by a short
  ceiling (`LOGIN_EMAIL_TIMEOUT_MS`, 3 s, versus the 30 s the cron-driven order emails use),
  and a failure or timeout is swallowed into the same answer. That keeps the gap to one
  provider round trip, but does not close it. Closing it fully means deferring the send (an
  outbox leg or a `waitUntil`), and the in-process plugin has neither for this path today.
  Per-IP limiting also blunts the timing probe, because it bounds how many samples an
  attacker can take.

## Amended 2026-10-02 — a live session is the same proof as the sign-in: owner at checkout, claim on listing

An order placed while signed in stayed a guest order: the checkout carried no identity, and the
order reached "Your orders" only at the shopper's next magic-link sign-in. The decision above is
unchanged. What changed is **when** the proof it already relies on is used.

- **A session counts as proof of the inbox until it expires or is revoked.** A session is
  minted by exactly one path, `verifyLogin`, after redeeming a link sent to the customer's
  email. Holding a live one therefore proves that inbox exactly as the redemption did, and it
  stops proving it the moment `SessionStore.validate` stops answering for it.
- **Owner at creation, only on a case-folded email match.** The checkout passes the session
  token; the domain's `checkoutOwner` resolves its customer and makes them the order's
  `customerId` only when the buyer email equals the customer's email under the guest-linking
  fold (lowercase both sides, nothing else). Any other email — a gift, a work address — stays a
  **guest order** under that email, claimable by whoever proves that inbox, so a session never
  attaches someone else's address to its account. An unusable session, or a session read that
  fails, is a guest order too: the session decides ownership, never whether the order is placed.
- **Claim on listing is equivalent in trust to the claim at sign-in.** `listCustomerOrders` runs
  `linkGuestOrders(customer, customer.email)` before listing. It reaches **only** orders the
  customer's next sign-in would claim anyway (same predicate, same fold, unowned orders only),
  so it grants nothing a sign-in would not. And it adds nothing for a thief: a stolen session
  already sees everything its account can list, and the claim only moves forward in time a
  link the owner's next sign-in would make anyway.
  **Cost:** one customer read plus one indexed query on the folded email per listing, and one
  compare-and-set per order actually claimed; once an inbox's orders are claimed the query
  finds nothing. Idempotent. A claim that fails (contention) is logged and the owned orders are
  listed anyway.
- **What soundness depends on.** (1) Sessions are minted only by `verifyLogin`; any other
  minting path (an admin "log in as", an SSO bridge) must prove the inbox too or this rule
  breaks. (2) A customer's email is immutable (`UpdateCustomerInput` carries no email); an
  email-change feature would let a session claim a new address's orders without proving it,
  and must re-prove the inbox first.
- **Coupons.** The owner is also the coupon redemption's `customerId`, so `maxUsesPerCustomer`
  now binds a signed-in, same-email checkout (`COUPON_MAX_PER_CUSTOMER`). Guest checkouts, and
  signed-in checkouts under another email, are not counted per customer — as before.
- **Revisit** if the credential mechanism stops proving email ownership (this ADR's own
  trigger), if a second session-minting path or an email-change flow is added, or if listing
  cost shows up (the claim could then move to a sweep keyed by verified email).

## Amended 2026-10-02 — the sign-in page may say a link was probably not sent, from the browser's own count

QA U-12: past the per-address cap the request no-ops and answers exactly as a sent one (above —
the throttle is not an oracle), so the sign-in page said "A sign-in link is on its way" for a
fourth request whose link never left. The decision above is unchanged: the plugin's answer stays
identical for every address, and the site never asks it which arm ran.

- **The site counts the BROWSER, not the address.** `POST /account/login/request` records each
  request that reached the plugin in a short-lived `otta_login_requests` cookie (HttpOnly,
  `path=/account/login`, 15 minutes, timestamps only — never an address; at most four kept).
  When this browser has asked more than the cap's worth (3) inside the window, it lands on
  `?sent=many`, whose notice says the request **may not** have sent a new link and to use the
  newest one or wait. A refused form, BUSY or an outage is not counted.
- **Why this is not an oracle.** The count is decided before, and regardless of, the plugin's
  answer, and it is the same for every address: four requests for four different addresses get
  the "many" notice too. It reveals nothing a browser did not already know about itself — not
  whether an address has an account, nor whether it is throttled.
- **The ordinary notice states the cap** ("we send at most 3 links to an address every 15
  minutes"). It is true of every address, and it is the only honest explanation available for a
  link that never arrives because someone else filled the address's window (the lockout above;
  per-IP limiting at the gateway remains the fix).
- **Limits.** A browser that clears its cookies, or several browsers, are each counted alone; the
  notice then errs towards the ordinary one, which now names the cap. The cap and window are
  mirrored in the site (`lib/account.ts`) only to word the notices; the plugin enforces them.
