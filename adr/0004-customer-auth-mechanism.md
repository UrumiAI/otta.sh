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
