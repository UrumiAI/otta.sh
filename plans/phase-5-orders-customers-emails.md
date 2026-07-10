# Phase 5 — Orders + Customers + Emails — Implementation Plan

_Plan only, no code. Written against `implementation-plan.md` Phases table row 5, following
the red→green discipline of Phase 0 (§0.1–0.6) and the seam discipline of ADR-0002._

---

## 1. Goal & headline test

**Goal:** order status lifecycle beyond "paid"; a storefront **customer** identity —
separate from EmDash `ctx.users` — with login, saved addresses, and order history; and
transactional emails fired exactly once per status transition.

**Headline test (from the Phases table, made precise):**

> A storefront customer (**not** `ctx.users`) with a saved address sees **only their own**
> order history; a status transition fires **exactly one** email.

Split into the concrete behavioral cases the suite must encode:

1. **Own-orders isolation.** Customer A and Customer B each have ≥1 order. Calling
   `listOrdersForCustomer` (service: `GET /me/orders`) authenticated as A returns only A's
   orders — B's orders never appear, even if requested by id (`GET /me/orders/:id` on B's
   order id, authenticated as A, returns `NOT_FOUND`, not `FORBIDDEN` — don't leak
   existence).
2. **No `ctx.users` involvement.** The customer record, session, and login flow have zero
   dependency on EmDash's admin/staff user system — a fresh EmDash install with no
   `ctx.users` at all can still authenticate a storefront customer. (Guards against
   silently reaching for `ctx.users` as a shortcut.)
3. **Address book scoping.** Same isolation rule for addresses: `GET /me/addresses`
   returns only the authenticated customer's addresses.
4. **Exactly-one email per transition.** Transitioning an order `paid → processing` (or
   any modeled transition) enqueues and sends **exactly one** email, verified via a fake
   `EmailSender` in the contract suite counting `send()` invocations keyed by
   `(orderId, transition)`.
5. **No double-send on retry.** The same transition applied twice — e.g., a Stripe webhook
   redelivery, or the admin endpoint called twice with the same request — still sends
   **exactly one** email and performs the status change **once** (idempotent transition +
   idempotent send are the same guarantee, see §5).
6. **Invalid transition rejected.** An out-of-order transition (e.g. `pending → shipped`)
   is rejected by the domain with a typed error and fires **zero** emails.

---

## 2. Scope

**In scope:**

- Order `state` field (extending `orders.state`, the column Phase 4's canonical schema
  actually creates — not `status`) + state machine + transition use-case (domain), whose
  enforced transition table is a superset of Phase 4's shipped `pending→paid` /
  `pending→failed` / `pending→expired` transitions (§5).
- `CustomerStore` port + Postgres/SQLite adapter: customers, addresses.
- Storefront login (magic-link, see §4) — `CustomerCredentialVerifier` port +
  `SessionStore` port, both adapters.
- `EmailSender` port + one concrete adapter (see §6) + templates for the transitions in
  scope.
- Outbox-backed exactly-once send (§5).
- New REST surface: auth, `/me`, `/me/orders`, `/me/addresses` (§7).
- Plugin: storefront account pages (login, order history, address book) under the
  workerd-on-Node sandbox — thin, HTTP-only, per ADR-0002.
- Contract-suite extensions for every new store/port.

**Out of scope (explicitly deferred):**

- Passkey/password as the *shipped* mechanism (magic-link ships; the port is built so
  either can be added later without touching the rest of the phase — see §4).
- Carrier tracking webhooks (shipped→delivered stays a manual admin transition in v1).
- Refund money-movement (a `refunded` status exists; the payment-gateway refund call
  itself is Phase 6/7-adjacent and not built here — treat as admin-marks-refunded after an
  out-of-band refund).
- Email template i18n/RTL polish beyond what DEVELOPMENT.md §5 already requires of any
  plugin-facing string (account pages get it; email HTML bodies get a follow-up pass).
- Admin Block Kit panel for order status (Phase 7 territory) — Phase 5 exposes the
  transition as a REST endpoint only; a panel can call it later.
- Account merge UX beyond the automatic email-match rule in §9.

---

## 3. Dependencies

**Reused from Phases 0–4:**

- `@urumi/domain` money/id branded types, `IdempotencyKey`, `Clock`, `IdGen` (adapter-architecture §1).
- The contract-suite harness (`describeEachDialect`-style wrapper) and its
  Postgres-required tagging convention (Phase 0.4/0.5) — every new store port reuses it
  verbatim.
- `OrderStore` and the `orders`/`order_items` tables from Phase 4 (price/title snapshot
  already in place) — Phase 5 **extends** `OrderStore`, it doesn't replace it. Phase 5 also
  inherits Phase 4's **canonical order schema** verbatim (Phase 4 §4): the status column is
  `orders.state` (not `status`), `orders` carries **no money columns** (totals live only in
  `order_totals`, `*_cents`), and `orders.customer_id` was already added — nullable,
  forward-only — by Phase 4; Phase 5 populates it but does not re-add or rename it.
- `@urumi/service`'s live-test-server HTTP contract-test pattern (Phase 0.6) — new
  endpoints get the same treatment.
- The plugin's `CommerceClient`/`HttpCommerceClient` seam (ADR-0002 §"Transport seam") —
  account pages are new storefront routes on the existing plugin, no new plugin
  capability beyond what checkout already declared (`network:request` + `allowedHosts`;
  confirm `email:send` is *not* needed — see §6 draft ADR).
- The hold-expiry cron precedent from Phase 3 — reused verbatim as the dispatch mechanism
  for the email outbox (§5).

**Provides to Phases 6–7:**

- `CustomerStore`/address book — Phase 6 taxes/shipping need a customer's address to rate
  shipping and resolve tax jurisdiction.
- `EmailSender` port — Phase 6 (coupon confirmation?) and Phase 7 (report digests) can
  reuse the port with new templates; no new port needed.
- The order `state` machine (`orders.state`) — Phase 7 reporting aggregates by state.
- The session/authorization pattern ("derive identity server-side, never trust a
  client-supplied id") — the template for any future authenticated storefront surface.

---

## 4. Customer identity design

### Schema (commerce Postgres, separate from EmDash's DB — design-decisions.md §4)

```
customers            id, email (unique, citext/lower-normalized), display_name,
                      created_at, email_verified_at
customer_sessions     id, customer_id, token_hash, created_at, expires_at,
                      revoked_at (nullable)
login_challenges      id, email, token_hash, created_at, expires_at, consumed_at (nullable)
addresses             id, customer_id, kind (billing|shipping), name, line1, line2,
                      city, region, postal_code, country, is_default, created_at
```

- `orders.customer_id` — nullable FK, added by **Phase 4** (forward-only) per its canonical
  schema; Phase 5 **populates** it (on login/claim) and does not re-add, rename, or
  re-declare it — the column lands exactly once. Supports guest checkout; a customer
  created *after* a guest order can claim it (§9).
- Tokens are **never stored in plaintext** — `token_hash` only (hash the opaque token
  server-side, same idea as an API-key store), so a DB read can't leak a usable session.

### Two ports, so the auth *mechanism* is isolated

The task requires the mechanism-specific part isolated behind a port so the rest of the
phase can proceed independent of the still-open decision. Split into **two** ports, not
one, because they change independently:

```ts
// Mechanism-specific — swapped when the auth mechanism changes.
interface CustomerCredentialVerifier {
  // magic-link: issue a one-time emailable token
  issueChallenge(email: Email): Promise<{ challengeId: string }>;
  // magic-link: redeem the token from the emailed link
  verifyChallenge(challengeId: string, token: string): Promise<
    { ok: true; customerId: CustomerId } | { ok: false; reason: "EXPIRED" | "INVALID" | "CONSUMED" }
  >;
}

// Mechanism-agnostic — stays the same across password/magic-link/passkey.
interface SessionStore {
  create(customerId: CustomerId): Promise<{ token: string; expiresAt: Date }>;
  validate(token: string): Promise<CustomerId | null>;
  revoke(token: string): Promise<void>;
}
```

Everything downstream of `SessionStore.validate` — `/me`, `/me/orders`,
`/me/addresses` — depends **only** on `SessionStore`, never on
`CustomerCredentialVerifier`. Swapping magic-link for passkey later means writing a new
`CustomerCredentialVerifier` adapter (and its own challenge/response REST route); zero
changes to session handling, authorization, or the account pages' data flow. This mirrors
the `PaymentGateway` precedent from Phase 4 (one port, swappable adapters, no ripple into
checkout).

### Session model through the sandbox-clean plugin

The plugin has no DB and reaches the service **only** via `ctx.http` + `allowedHosts`
(non-negotiable, CLAUDE.md). The end-user's browser talks to the **plugin's** storefront
origin, not the service's origin directly (the service isn't part of the trust boundary
the browser sees). So:

1. On successful `verifyChallenge`, the service mints a session token via `SessionStore`
   and returns it in the HTTP response body (**not** a `Set-Cookie` from the service — the
   service is a different origin and CLAUDE.md requires all plugin↔service traffic go
   through `ctx.http`, not the browser directly).
2. The **plugin's** storefront route (first-party on the merchant's domain) sets the
   session token as an `httpOnly`, `Secure`, `SameSite=Lax` cookie on its own response.
   This needs no new EmDash capability — routes already set arbitrary response
   headers/cookies within their existing `public: true` route capability.
3. On every subsequent request, the plugin route reads its own cookie and passes the
   token to `HttpCommerceClient` as an `Authorization: Bearer <token>` header — a normal
   `ctx.http` call, already-declared `allowedHosts`.
4. The **service** is the sole authority on identity: it calls `SessionStore.validate` and
   derives `customerId` server-side. **The service never trusts a `customerId` passed in
   a request body or query string** — every `/me/*` handler resolves identity purely from
   the bearer token. This is the actual mechanism behind "sees only own orders": it isn't
   a filter the client can bypass, it's the only identity the query planner is given.

No new plugin capability is needed beyond what checkout already declared in Phase 4.

### Draft ADR — Customer auth mechanism (to confirm; not yet placed under `adr/`)

> **Status:** proposed (draft, this plan) — promote to `adr/000N-customer-auth-mechanism.md`
> once confirmed.
>
> **Context.** Storefront customers need to authenticate; component-map.md and
> design-decisions.md leave the mechanism open (password / magic-link / passkey), noting
> it "can mirror `@emdash-cms/auth` patterns" but must be a **separate identity**.
>
> **Decision (recommended): ship magic-link (passwordless email link) as the v1
> mechanism**, behind the `CustomerCredentialVerifier` port described above.
>
> **Reasoning:**
> - **No password storage liability.** No hash/salt scheme to get right, no breach
>   surface, no "forgot password" flow to build and secure — eliminates a whole class of
>   commerce-service security review before v1 ships.
> - **Forces the `EmailSender` port to exist on day one of this phase**, rather than being
>   introduced only for order-status emails. Login-email and status-email share one port
>   from the start — good sequencing, not a coincidence (see §6).
> - **Matches the sandbox constraint well.** No client-side crypto (unlike passkey/WebAuthn,
>   which needs `navigator.credentials` and RP-ID configuration that's awkward to test
>   under a Block-Kit/non-React sandboxed storefront and adds real complexity
>   disproportionate to v1 scope).
> - **Lower friction than password for a v1 storefront** with no account-recovery flow
>   built yet; consistent with modern storefront patterns (Shopify's passwordless
>   customer accounts).
> - **Passkey is the better long-term answer** (device-bound, phishing-resistant) and
>   should be revisited **once the port is proven** — the two-port split above is
>   specifically so that upgrade is additive, not a rewrite.
>
> **Consequences:** a customer without immediate email access can't log in (mitigate with
> a long-lived session so magic-link isn't needed every visit — see §9 rate-limit note
> too). Building this the day the port lands means the phase does not block on the
> decision — if the recommendation is rejected in favor of password, only
> `CustomerCredentialVerifier`'s adapter and its REST route change.

---

## 5. Order state design

### State set (`orders.state` — Phase 4 is authoritative for the states it ships; Phase 5
adds the rest, explicitly marked)

> **Blocker fix.** The prior draft's enforced state machine omitted Phase 4's `expired`
> state and the `pending → expired` transition, which the revised Phase 4 plan ships and
> depends on (Phase 4 §3/§5: its order-expiry sweep performs exactly this transition and
> requires Phase 5's domain-enforced table to accept it). This revision aligns the state
> set and transition table **exactly** with Phase 4: every state/transition Phase 4 ships is
> reproduced verbatim below (not re-implemented — Phase 4's guard/release logic is
> untouched), and every state/transition Phase 5 adds is marked **(Phase 5 addition)** so
> nothing is mistaken for pre-existing Phase-4 behavior. The column itself is also corrected
> to `orders.state`, matching Phase 4's canonical schema (the prior draft called it
> `orders.status`, a column Phase 4 never creates).

| State | Meaning | Terminal? | Shipped by |
| --- | --- | --- | --- |
| `pending` | Order created, payment not yet confirmed | no | Phase 4 |
| `paid` | Payment confirmed (Stripe webhook or x402 gate) | no | Phase 4 |
| `failed` | Payment failed | yes | Phase 4 |
| `expired` | Checkout hold TTL passed while unpaid — Phase 4's guarded sweep already released the adopted reservation on entry (Phase 4 §5) | yes | Phase 4 |
| `processing` | Merchant has begun fulfillment (physical only) | no | Phase 5 addition |
| `shipped` | Parcel handed to carrier (physical only) | no | Phase 5 addition |
| `delivered` | Carrier confirms delivery (physical only, manual in v1) | no | Phase 5 addition |
| `completed` | Terminal success — immediate for digital (on `paid`), manual/auto for physical (on `delivered`) | yes | Phase 5 addition |
| `cancelled` | Cancelled before fulfillment | yes | Phase 5 addition |
| `refunded` | Refund recorded (out-of-band money movement, in-scope status only) | yes | Phase 5 addition |

### Allowed transitions (the state machine — enforced in the domain, not the DB or the client)

```
pending    → paid        (Phase 4, already shipped: verified webhook/x402 payment success)
pending    → failed      (Phase 4, already shipped: webhook payment failure)
pending    → expired     (Phase 4, already shipped: order-hold-TTL guarded sweep;
                           reservation release already happens inside Phase 4's transition,
                           not repeated here)
pending    → cancelled   (Phase 5 addition: customer or admin, pre-payment)
paid       → processing  (Phase 5 addition: admin; physical only)
paid       → completed   (Phase 5 addition: system; digital only, immediate on paid)
paid       → cancelled   (Phase 5 addition: admin; pre-fulfillment)
processing → shipped     (Phase 5 addition: admin)
processing → cancelled   (Phase 5 addition: admin; pre-shipment)
shipped    → delivered   (Phase 5 addition: admin; manual in v1, no carrier webhook yet)
delivered  → completed   (Phase 5 addition: admin, or auto-transition after N days — a follow-up, not v1)
{paid, processing, shipped, delivered, completed} → refunded (Phase 5 addition: admin; within return window)
```

Any transition not in this table is rejected by the domain use-case with a typed error
(`INVALID_TRANSITION`), never silently coerced — including, now, `pending → expired`, which
must be **accepted**, not rejected. Phase 5's table is a strict superset of Phase 4's: the
three Phase-4-authoritative rows above are included so the shared "reject anything not
listed" enforcement doesn't strand Phase 4's own transition, but Phase 5 does not
re-implement their guard/release semantics — those stay exactly where Phase 4 put them
(the guarded `UPDATE … WHERE state=:from RETURNING`, and reservation commit/release). Phase
5 only (a) adds the table entries so the domain doesn't reject them, and (b) wires them into
the outbox (below) so each one also enqueues at most one email.

**Who can transition** is enforced at the service layer, not the domain: webhook/sweep-
originated transitions (`pending→paid`, `pending→failed`, `pending→expired`) come from the
existing payment-gateway webhook handlers and the order-expiry sweep (both Phase 4);
everything else requires an authenticated **admin** request (not a customer request — no
customer-facing endpoint can transition status in v1).

### Exactly-once email — outbox pattern (recommended over "idempotent send keyed on transition id" alone)

These are not really two competing designs — the outbox pattern **is** how you get an
idempotent send in the presence of crashes. But unlike inventory's guarded flip, the
status `UPDATE` and the outbox `INSERT` are genuinely **two statements**, and "atomic"
cannot be left implicit (should-fix from review: the prior draft asserted atomicity
without stating a mechanism). Here is the mechanism, made explicit:

1. **Mechanism: same-transaction insert, not a two-step guarded choreography.** The
   status-transition use-case wraps the guarded `UPDATE` and the outbox `INSERT` in a
   single Postgres transaction on one connection:

   ```sql
   BEGIN;
   UPDATE orders SET state = :toState, updated_at = :now
    WHERE id = :orderId AND state = :fromState
    RETURNING id;                                  -- 0 rows ⇒ already transitioned; ROLLBACK, return "no-op, current state unchanged"
   INSERT INTO order_emails_outbox (order_id, to_state, status, created_at)
    VALUES (:orderId, :toState, 'pending', :now)
    ON CONFLICT (order_id, to_state) DO NOTHING;   -- unique constraint still guards double-enqueue
   COMMIT;
   ```

   This is deliberately **different** from the inventory guarded-flip idiom (a single bare
   statement, no `BEGIN`/`COMMIT`, chosen there so the port stays satisfiable by a future
   non-interactive D1 `EmdashStore`). The email outbox has no such portability constraint:
   per §3/§6, `EmailSender` and its outbox table are **service-only** — there is no D1/
   EmDash adapter for email and none is planned — so nothing here needs to satisfy the
   D1 no-interactive-transaction discipline. A real transaction is therefore both correct
   and simpler than a two-step guarded choreography.

   **Failure windows:** a crash or connection loss *before* `COMMIT` rolls back both
   statements together — there is no reachable state where the order transitioned but no
   outbox row exists, or vice versa. A crash *after* `COMMIT` is indistinguishable from
   ordinary success; the dispatcher (step 2) picks up the committed row normally. A retry
   of the same transition after a rolled-back attempt just re-runs the same transaction,
   which is idempotent on both sides (`WHERE state = :fromState` and
   `UNIQUE(order_id, to_state)` both no-op on replay). **Net result: zero failure window**
   — this is the point of using a real transaction instead of a guarded two-step, and it's
   available here specifically because email is service-only.

   **Implementation constraint for 5.5:** both statements must execute on the same pooled
   connection for the transaction to hold; the contract suite must assert this directly
   (`orderTransitionContract`, new case) by forcing a rollback mid-transition and asserting
   *neither* the state change nor the outbox row is visible afterward — not just testing
   the happy path.

   **Healing / defense in depth:** because the write is transactional there is no expected
   steady-state drift for a sweep to heal. As a cheap secondary safety net (not required
   for correctness), the outbox dispatcher (step 2 / §8 step 5.8) can log — not
   auto-repair — any order whose current state has no matching `order_emails_outbox` row,
   which only fires if some future change bypasses the transactional path (e.g. a manual
   SQL fix).

2. A separate dispatcher (reusing the Phase-3 hold-expiry-cron pattern verbatim) claims
   pending outbox rows with the same atomic idiom:
   `UPDATE order_emails_outbox SET status='sending' WHERE id=:id AND status='pending'
   RETURNING *` — only one process/attempt can ever win the claim, so even concurrent
   dispatcher runs can't double-send.
3. On successful `EmailSender.send()`, mark the row `sent_at`. On failure, mark `pending`
   again (or `failed` after N retries) so the next cron tick retries — durable retry
   without re-running the state transition itself.

This gives exactly-once **enqueue** (transactional write + unique constraint on
`(order_id, to_state)`) and exactly-once **attempt-claim** (conditional
`UPDATE … RETURNING`), which composes to exactly-once delivery under ordinary retry/
redelivery. It is testable without a real SMTP server: the contract suite's
`FakeEmailSender` counts invocations, and a "fire the same transition twice" test asserts
the outbox table has exactly one row and the fake was called exactly once.

### Email on `expired`

**Decision: yes — `pending → expired` enqueues exactly one `order-expired` email**, through
the identical mechanism above. Rationale: the plan's other non-success terminal states
(`cancelled`, `refunded`) already get a customer-facing email; leaving `expired` silent
would make it the one terminal state where a customer's checkout hold released their items
back to stock and they hear nothing about it. `order-expired` is added to the template list
(§6): plain transactional language ("your checkout session expired and the items were
released back to stock — you're welcome to try again"), not marketing copy.

**Wiring, not duplication.** Phase 4's `expireOrders(now)` use-case currently performs its
guarded `UPDATE orders SET state='expired' …` directly, with no outbox involvement (Phase 5
didn't exist yet when Phase 4 was written — Phase 4 explicitly hands this off as a "state-
transition hook point," §3 of the Phase 4 plan). Phase 5 **extends that call site** to run
inside the same transactional guard-plus-outbox primitive introduced above, exactly as it
already does for the webhook-originated `pending→paid`/`pending→failed` transitions (§7).
`POST /internal/expire-orders` gets the identical extension. To be precise about the
mechanism: Phase 4's `expireOrders` flip is a **bare guarded statement, not a transaction** —
there is no pre-existing transaction to append to. Phase 5 **introduces** the transaction here
(legitimately, per the service-only justification above), wrapping Phase 4's existing guarded
`pending → expired` flip and the new outbox insert together in it. Phase 4's guard and
reservation-release logic are reused verbatim inside that new wrapper — Phase 5 adds the
transactional boundary + the outbox insert around the existing flip; it does not rewrite the
release path.

Note: this leaves `pending → failed` as the one Phase-4-shipped transition with no matching
template in §6 — that asymmetry predates this revision and neither review flagged it as a
blocker. Left as-is here to keep this revision scoped to what was requested; tracked as a
follow-up in §9 rather than designed now.

---

## 6. Email design

### `EmailSender` port

```ts
interface EmailSender {
  send(input: {
    to: Email;
    template: EmailTemplate;         // see below
    data: Record<string, unknown>;   // template-specific, validated by caller
    idempotencyKey: string;          // = outbox row id; adapters may use it for provider-side dedup too
  }): Promise<void>;
}
```

### Templates in scope

- `customer-login-link` (magic-link email — the first consumer of the port, per §4)
- `order-confirmation` (`paid`)
- `order-processing`
- `order-shipped`
- `order-delivered`
- `order-completed`
- `order-cancelled`
- `order-refunded`
- `order-expired` (§5 — fires on the Phase-4-shipped `pending → expired` transition)

Templates are plain-text + HTML pairs, i18n-ready (interpolated strings, no
concatenation), rendered from order/customer data passed explicitly — no template reaches
back into a store itself (keeps `EmailSender` IO-shaped but logic-free, consistent with
ports expressing intent, not mechanism).

### Draft ADR — Transactional email transport (to confirm; not yet placed under `adr/`)

> **Status:** proposed (draft, this plan) — promote to `adr/000N-transactional-email-transport.md`
> once confirmed.
>
> **Context.** component-map.md leaves the tier open: EmDash's plugin `email:send`
> capability + hook pipeline, vs. the commerce **service** sending mail itself
> (SMTP/transactional-API).
>
> **Decision (recommended): the service sends email directly** (an `EmailSender` port with
> a concrete SMTP/transactional-API adapter, e.g. an SMTP relay or a provider API client —
> the specific vendor is an implementation detail behind the port, not an architectural
> choice), **not** via EmDash's `email:send` plugin capability.
>
> **Reasoning:**
> - **Wrong-direction dependency.** Most email triggers in this phase originate
>   service-side: a Stripe webhook hitting `@urumi/service` directly, or an admin REST
>   call to the service. Neither passes through the plugin's request lifecycle. Routing
>   the send through `email:send` would require the **service to call back into the
>   plugin** to trigger a send — inverting the plugin→service direction ADR-0002 fixed the
>   whole architecture around, and introducing a second transport direction that doesn't
>   otherwise exist anywhere in this design.
> - **Outbox pattern needs a durable table the sender itself can retry against** (§5) — that
>   table is naturally commerce-service state. Splitting "the row that says whether an
>   email was sent" from "the code that sends it" across the plugin/service boundary adds
>   a synchronization problem with no offsetting benefit.
> - **Host-agnostic goal (ADR-0002).** The service is meant to work for non-EmDash
>   storefronts too, per ADR-0002's framing of the plugin/service split as a "deployment
>   choice." An `email:send`-dependent design pins transactional email to EmDash
>   specifically; a service-owned `EmailSender` port does not.
> - **Precedent already in this codebase.** `PaymentGateway` is exactly this shape — a
>   port owned by the domain/service, concrete adapters swapped by deployment. Reusing the
>   pattern is cheaper than inventing a plugin-mediated alternative.
>
> **Consequences:** the service needs its own outbound-email credentials/deliverability
> setup (SPF/DKIM for the sending domain) — an ops task, not an architectural one. If
> EmDash's pipeline is preferred later (e.g. for unified deliverability across CMS +
> commerce mail), it's an additional `EmailSender` adapter, not a redesign.

### What's tested

- `FakeEmailSender` (in-memory, records `{to, template, data, idempotencyKey}` per call) —
  the **first adapter** to pass the contract suite (Phase-0.3 precedent: prove the port
  shape before any real transport).
- Exactly-one-send assertions (§1 cases 4–5) run against the fake in the domain/contract
  suite — no real SMTP server in CI for these.
- A separate, smaller smoke test against the real adapter (e.g. hitting a local SMTP
  sink/Mailhog in dev) confirms the concrete adapter implements the port — not part of the
  concurrency-style contract suite.

---

## 7. New service surface

### REST endpoints (mirror the ports 1:1, per adapter-architecture rule #2 — no
endpoint has semantics the port lacks)

| Endpoint | Port(s) | Auth |
| --- | --- | --- |
| `POST /auth/login/request` `{email}` | `CustomerCredentialVerifier.issueChallenge` | none (rate-limited, §9) |
| `POST /auth/login/verify` `{challengeId, token}` → `{sessionToken}` | `CustomerCredentialVerifier.verifyChallenge` + `SessionStore.create` | none |
| `POST /auth/logout` | `SessionStore.revoke` | bearer session |
| `GET /me` | `SessionStore.validate` + `CustomerStore.get` | bearer session |
| `GET /me/orders` | `SessionStore.validate` + `OrderStore.listForCustomer` | bearer session |
| `GET /me/orders/:id` | same, plus ownership check (404 if not owner) | bearer session |
| `GET /me/addresses` / `POST` / `PUT /:id` / `DELETE /:id` | `AddressStore` (scoped to session's `customerId`) | bearer session |
| `POST /admin/orders/:id/transition` `{toState}` | order-state use-case (§5) | admin auth (existing service admin auth from earlier phases — confirm mechanism in 5.1; out of scope to redesign here) |
| _(internal)_ Phase-4 webhook handlers extended to call the same transactional transition+outbox use-case for `pending→paid`/`pending→failed` | order-state use-case | existing webhook signature verification (Phase 4) |
| _(internal)_ `POST /internal/expire-orders` (Phase 4) extended identically for `pending→expired` | order-state use-case | internal/self-interval trigger (Phase 4) |

### New ports

- `CustomerStore` — `create`, `get(id)`, `getByEmail`, `update`.
- `AddressStore` — `list(customerId)`, `create`, `update`, `delete`, all scoped by
  `customerId` at the port signature level (never "get by address id alone" — every method
  takes the owning `customerId` so a Postgres adapter bug can't accidentally cross-tenant
  leak; enforced again at the service layer from the session, per §4).
- `SessionStore`, `CustomerCredentialVerifier` — §4.
- `EmailSender` — §6.
- `OrderStore` extension — `transition(orderId, fromState, toState, idempotencyKey)`,
  `listForCustomer(customerId)`. `transition` is the single primitive used by 5.1's own
  legality check *and* by the extended Phase-4 webhook/expiry call sites (§5), so
  `pending→paid`/`pending→failed`/`pending→expired` and every Phase-5-added transition all
  go through one guarded-UPDATE-plus-outbox-INSERT implementation.

### Contract-suite extensions

- `customerStoreContract(makeStore)` — create/get/getByEmail/update + unique-email
  constraint behavior.
- `addressBookContract(makeStore)` — CRUD + cross-customer isolation (case: creating two
  customers, asserting `list(customerA)` never returns customerB's rows).
- `sessionContract(makeStore)` — create/validate/revoke, expiry, revoked-token rejection.
- `orderTransitionContract(makeStore, makeEmailSender)` — the state machine table from §5,
  **including the three Phase-4-authoritative rows** (`pending→paid`/`failed`/`expired`)
  so a regression that drops them again is caught here, not just re-reviewed (every legal
  transition succeeds once; every illegal transition — explicitly including
  `pending→shipped` and any transition into a Phase-4 state from a Phase-5 state — is
  rejected; replay of the same transition is a no-op) **plus** the exactly-one-email
  assertion via the fake sender — this is where headline-test cases 4–6 actually live as
  reusable, per-adapter test code. On the Postgres adapter specifically, also asserts the
  transactional-atomicity case from §5 (forced rollback mid-transition leaves neither the
  state change nor the outbox row).
- All four run on SQLite locally and Postgres in CI, per the existing dialect-parameterized
  wrapper. None of these need the Postgres-only concurrency tagging (§5's atomicity comes
  from a real transaction, not a race-prone guarded flip, so the behavioral contract
  doesn't require a race to observe, unlike inventory's oversell test) — flag this for
  reconsideration only if a future "concurrent duplicate webhook" test is added.

---

## 8. Ordered red→green steps

Numbered `5.x`, same governing rule as Phase 0: failing test named first, minimum code
after, "done" = the named test is green.

### 5.1 — Extend `OrderStore` port + state types (types + fake, no DB)

- Add `OrderState` union type (`orders.state`, matching Phase 4's canonical column — not
  `OrderStatus`/`status`) and the transition table (§5) as data, not scattered conditionals
  — a single exported state-machine map the domain and any UI can both read. The table
  includes Phase 4's `pending→paid`/`pending→failed`/`pending→expired` verbatim alongside
  the Phase-5-added transitions.
- Extend the in-memory fake `OrderStore` (Phase-4 test-utils) with `transition` and
  `listForCustomer`.
- **Tests (`domain/orders/transition.test.ts`):**
  1. `"transitions pending to paid"` — legal transition succeeds, returns new state.
  2. `"rejects pending to shipped as INVALID_TRANSITION"`.
  3. `"accepts pending to expired as a legal Phase-4-authoritative transition"` — the
     literal regression test for the dropped-`expired` blocker: fails on the prior draft's
     table, passes once `expired` is included.
  4. `"replaying the same transition is a no-op and returns the current state"` — this is
     headline case 5, written against the fake first.
  5. `"listForCustomer returns only that customer's orders"` — headline case 1, against
     the fake.
- **✅ Green when:** all five pass against the fake.

### 5.2 — `CustomerStore`, `AddressStore`, `SessionStore`, `CustomerCredentialVerifier` ports + fakes

- Define the four port interfaces (§4, §7) and their in-memory fakes.
- **Tests (`domain/customers/*.test.ts`):**
  1. `"creates a customer and finds it by email"`.
  2. `"address list is scoped to the owning customer"` — headline case 3, against the fake.
  3. `"issueChallenge then verifyChallenge with the right token returns the customer id"`.
  4. `"verifyChallenge with an expired token returns EXPIRED"`.
  5. `"verifyChallenge with an already-consumed token returns CONSUMED"` (guards replay of
     a magic-link URL).
  6. `"SessionStore.validate rejects a revoked token"`.
- **✅ Green when:** all pass against the fakes.

### 5.3 — `EmailSender` port + `FakeEmailSender`, outbox use-case

- Define `EmailSender` (§6) and `FakeEmailSender` test double.
- Add the outbox-backed transition use-case wrapping 5.1's `transition`: one call that
  transitions state **and** enqueues the matching template (§5's transactional
  same-connection design), against fakes for both `OrderStore` and the outbox. Against the
  fakes this proves shape/behavior only — the actual `BEGIN`/`COMMIT` atomicity is a
  Postgres-adapter property and is tested for real in 5.5.
- **Tests (`domain/orders/transition-emails.test.ts`):**
  1. `"paid to processing enqueues exactly one order-processing email"` — headline case 4.
  2. `"the same transition applied twice sends exactly one email"` — headline case 5, the
     core exactly-once assertion, against the fakes.
  3. `"an invalid transition enqueues zero emails"` — headline case 6.
  4. `"pending to expired enqueues exactly one order-expired email"` — the email-on-`expired`
     decision (§5), written against the fake first.
- **✅ Green when:** all four pass against the fakes.

### 5.4 — Lift 5.1–5.3 into the shared contract suite

- `customerStoreContract`, `addressBookContract`, `sessionContract`,
  `orderTransitionContract` (§7) — each parameterized by a store factory, each first run
  against its fake (Phase-0.3 precedent: fake proves the port shape before any DB).
- **✅ Green when:** all four contract suites pass against their fakes.

### 5.5 — `@urumi/store-postgres`: migrations + adapters for all four new stores

- Forward-only migrations: `customers`, `addresses`, `customer_sessions`,
  `login_challenges`, `order_emails_outbox` (`UNIQUE(order_id, to_state)`). `orders.
  customer_id` is **not** migrated here — Phase 4 already added it; this step only
  populates it.
- Real adapters implementing the four ports. `SessionStore`/`CustomerStore`/`AddressStore`
  use the same conditional-`UPDATE … RETURNING` idiom used for inventory. The order
  `transition` use-case's adapter runs the guarded `UPDATE` + outbox `INSERT` inside a
  single `BEGIN`/`COMMIT` transaction on one connection (§5) — **not** the bare-statement
  idiom, since this path has no D1-portability requirement.
- **Tests, in addition to the four contract suites:**
  - `"a forced rollback mid-transition leaves neither the state change nor the outbox row"`
    — the atomicity case from §5, run against Postgres (and SQLite, which also supports
    transactions synchronously via `better-sqlite3`).
- Run all four contract suites (5.4) against **both** SQLite and Postgres via the existing
  dialect wrapper.
- **✅ Green when:** all four contract suites, plus the rollback-atomicity test, are green
  on SQLite and Postgres.

### 5.6 — `@urumi/service`: REST endpoints + live-server contract tests

- Wire the endpoints in §7's table.
- **Extend, don't duplicate:** Phase 4's existing webhook handlers (`pending→paid`/
  `pending→failed`) and `POST /internal/expire-orders` (`pending→expired`) are changed to
  call 5.3/5.5's shared transactional `transition` use-case instead of their own raw
  guarded `UPDATE`, so all three Phase-4-authoritative transitions now also enqueue an
  email. Phase 4's guard predicate and reservation commit/release logic inside that same
  transaction are unchanged.
- Session auth middleware: resolves `customerId` from the bearer token via
  `SessionStore.validate`; every `/me/*` handler uses only that resolved id (never a
  request param) — the concrete enforcement of "sees only own orders."
- **HTTP contract tests** (live test server, Phase-0.6 pattern): re-run the
  `orderTransitionContract` and `addressBookContract` cases over real HTTP, plus:
  1. `"GET /me/orders/:id for another customer's order returns 404"` — headline case 1
     restated at the wire level, guards against leaking existence via a 403.
  2. `"POST /auth/login/verify with a stale challenge returns 401, not customer detail"`.
  3. `"the order-expiry sweep transitions pending to expired, releases the reservation
     exactly once (Phase-4 behavior unchanged), and enqueues exactly one order-expired
     email"` — proves the extended `/internal/expire-orders` call site didn't regress
     Phase 4's release guarantee while adding the email.
- **✅ Green when:** the HTTP contract tests pass against a live server backed by Postgres.

### 5.7 — Concrete `EmailSender` adapter (SMTP/transactional API) + login email wiring

- Implement the adapter chosen in §6's draft ADR; wire `/auth/login/request` to call
  `EmailSender.send(customer-login-link)` via `CustomerCredentialVerifier.issueChallenge`.
- Dev-environment smoke test against a local SMTP sink (not part of the CI contract
  suite — a manual/CI-optional check that the adapter satisfies the port at all).
- **✅ Green when:** a login email is observably sent in the dev sandbox (SMTP sink shows
  the message); no change to any contract-suite test (the fake still gates CI).

### 5.8 — Outbox dispatcher cron

- Reuse the Phase-3 hold-expiry-cron scaffolding: a scheduled job that claims pending
  outbox rows (§5's atomic claim) and calls `EmailSender.send`.
- **Test:** `"a crashed dispatcher run leaves the row claimable again after its lease
  expires"` (or equivalent lease/retry semantics) — guards the retry path, not just the
  happy path.
- **✅ Green when:** this test passes and the dispatcher runs green alongside 5.3's
  in-process outbox tests without double-sending.

### 5.9 — Plugin: storefront account pages under the workerd-on-Node sandbox

- New sandboxed, `public: true` storefront routes: `/account/login`,
  `/account/orders`, `/account/orders/:id`, `/account/addresses` — Block-Kit-free (these
  are plain storefront pages, not admin UI, so ordinary Astro/plugin page rendering
  applies, not the Block Kit constraint that's specific to **admin** field widgets).
  Sets/reads the session cookie (§4) and calls `HttpCommerceClient` methods that mirror
  the `/me/*` endpoints 1:1.
- **Tests, run under workerd-on-Node (not trusted in-process — CLAUDE.md non-negotiable):**
  1. `"logged-in customer sees only their own orders on /account/orders"` — headline case
     1, now at the plugin layer.
  2. `"an unauthenticated request to /account/orders redirects to /account/login"`.
  3. A capability-surface check (existing CI pattern from Phase 1+): the plugin declares
     no new capability beyond `network:request`/`allowedHosts` — no `email:send`, no new
     `ctx.storage` usage, confirming the §6 ADR's "service sends email directly" holds in
     practice.
- **✅ Green when:** all three pass under the sandbox runner.

**Phase 5 Definition of Done:** see §10.

---

## 9. Risks & open questions

1. **Customer auth mechanism — gating decision.** Recommendation: **magic-link** (§4
   draft ADR). Risk if rejected: low — the `CustomerCredentialVerifier`/`SessionStore`
   split means switching to password or passkey only touches 5.2's verifier adapter and
   its two `/auth/*` routes; nothing in 5.4–5.9 changes.

2. **Transactional email transport — gating decision.** Recommendation: **service sends
   directly** via `EmailSender`, not EmDash's `email:send` (§6 draft ADR). Risk if
   rejected: medium — would require inverting the service→plugin call direction for the
   outbox dispatcher, which ADR-0002 specifically avoided elsewhere; flag this explicitly
   for the decision-maker rather than defaulting silently.

3. **Guest-order → account linking.** A guest order created in Phase 4 has an email but no
   `customer_id`. Recommendation: **link automatically at first successful magic-link
   login** matching the order's email — safe specifically because a magic-link login
   already proves the person owns that inbox (equivalent proof to clicking an order
   confirmation link), so no separate "claim your orders" flow is needed. Would need
   revisiting if the auth mechanism decision (#1) changes to something that doesn't prove
   email ownership as a side effect (e.g. plain password) — flag as a dependency between
   #1 and this item.

4. **Magic-link abuse (email bombing / enumeration).** `POST /auth/login/request` must
   rate-limit per email/IP and return an identical response whether or not the email
   exists (`"if an account exists, we've sent a link"`), else it's an account-existence
   oracle. Add as an explicit test in 5.6, not just a code comment.

5. **Session storage: opaque DB-backed tokens vs JWT.** Recommendation: **opaque,
   DB-backed** (as designed in §4) — not JWT — because logout/revocation must actually
   work, and JWT revocation just reinvents a server-side denylist anyway. Consistent with
   "real databases, never mocks" and the existing idempotency-key pattern.

6. **`delivered → completed` auto-transition after N days** is named in §5 as a
   follow-up, not v1. Risk: orders could sit in `delivered` indefinitely with no terminal
   state. Low risk for v1 (admin can transition manually); flag for Phase 6/7 pickup via
   the same cron pattern as the outbox dispatcher.

7. **Admin auth mechanism for `/admin/orders/:id/transition`** is assumed to already exist
   from an earlier phase's service admin auth; if it doesn't yet exist, 5.6 needs a
   preceding step to establish it. Confirm during 5.1 kickoff before relying on it.

8. **`pending → failed` has no matching email template**, while `pending → expired` now
   does (§5's email-on-`expired` decision). This asymmetry predates this revision and is
   left as-is to keep this revision scoped to what review requested; a follow-up should
   decide whether a payment-failure notification is warranted (it may legitimately not be,
   if the buyer is already looking at a failed-payment page at the moment of failure,
   unlike an expiry which happens passively in the background).

9. **Storefront "Block-Kit-free" claim (5.9)** is asserted without an `emdash:`-prefixed
   citation, unlike the rest of the plan (Reviewer B nit). Confirm against EmDash's
   platform source/notes that a sandboxed plugin's `public: true` storefront routes render
   plain HTML the way §4/§5.9 assume, before building 5.9 — not expected to change the
   design, but should be a citation, not an assumption, before code is written.

---

## 10. Definition of done

Per CLAUDE.md's verification policy (domain/adapter/service tasks: contract suite is the
spec; plugin tasks: sandbox-required):

- [ ] `orderTransitionContract`, `customerStoreContract`, `addressBookContract`,
      `sessionContract` all green on **both** SQLite and Postgres (Phase-0.4-style
      dialect matrix); passing Postgres run recorded in the PR.
- [ ] **State machine matches Phase 4 exactly:** `orders.state` (not `status`) includes
      `pending`/`paid`/`failed`/`expired` as Phase 4 ships them plus Phase 5's additions;
      `pending → expired` is accepted, not rejected, by the domain-enforced table
      (`orderTransitionContract` regression case, 5.1/5.4).
- [ ] **Outbox atomicity proven, not asserted:** the guarded state `UPDATE` and the
      `order_emails_outbox` `INSERT` run in one Postgres transaction on one connection; the
      forced-rollback contract case (5.5) shows neither write is visible on abort.
- [ ] **`pending → expired` enqueues exactly one `order-expired` email**, wired through
      Phase 4's extended (not duplicated) `expireOrders`/`/internal/expire-orders` call
      site, without changing Phase 4's reservation-release behavior (5.6 HTTP test).
- [ ] Exactly-one-email assertions (headline cases 4–6, including `expired`) pass via
      `FakeEmailSender` in the contract suite — recorded as the canonical exactly-once
      evidence (not the real SMTP adapter, which is smoke-tested separately per 5.7).
- [ ] HTTP contract tests (5.6) pass against a live test server backed by Postgres —
      wire-format fidelity to the four new ports.
- [ ] No new `orders`/`order_items`/`order_totals` column is introduced by Phase 5 that
      conflicts with Phase 4's canonical schema (§4 of the Phase 4 plan); `orders.
      customer_id` is populated, not re-added.
- [ ] `@urumi/domain` still imports nothing with IO — boundary lint green (`pnpm lint`
      dependency-cruiser check), including the four new ports.
- [ ] Plugin account pages (5.9) pass their sandbox tests under **workerd-on-Node**, not
      trusted in-process mode; capability-surface check confirms no new capability beyond
      `network:request`/`allowedHosts`.
- [ ] Both draft ADRs (§4, §6) either promoted to `adr/000N-*.md` with `Status: accepted`,
      or explicitly left `proposed` with the decision-maker's sign-off noted in the PR —
      not silently assumed.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` clean; changeset added for every
      published package touched (`@urumi/domain`, `@urumi/store-postgres`,
      `@urumi/service`, `@urumi/plugin`).
- [ ] Migrations are forward-only; no existing Phase 0–4 migration edited.
- [ ] No `ctx.users` import or dependency anywhere in the new customer/session/auth code
      (headline case 2) — worth a literal grep-based CI check given how easy it'd be to
      reach for the wrong user table by habit.

---

## 11. Revision log (plan-review REQUEST CHANGES → resolutions)

Each finding from the two-reviewer plan review and how this revision resolves it.

| # | Finding (reviewer) | Resolution |
| --- | --- | --- |
| 1 | **Enforced state machine drops Phase 4's `expired` state** (B, blocker; also B's cross-phase C2, and Phase 4's own finding 5a) — Phase 5's table would reject the `pending → expired` transition Phase 4 ships. | §5 rewritten: state set and transition table now reproduce Phase 4's `pending`/`paid`/`failed`/`expired` and its three shipped transitions **verbatim**, each marked "Shipped by: Phase 4"; Phase 5's own states/transitions are marked **(Phase 5 addition)**. The column itself is corrected from `orders.status` to `orders.state`, matching Phase 4's canonical schema. New regression test (5.1, `orderTransitionContract`) pins `pending→expired` as legal so this can't silently regress again. Also decided: `pending → expired` fires exactly one `order-expired` email (§5, new subsection), wired by **extending** Phase 4's existing `expireOrders`/`/internal/expire-orders` call site (not duplicating it) to run through the same transactional transition+outbox primitive — Phase 4's guard and reservation-release logic is untouched. |
| 2 | **Outbox exactly-once relies on unstated `UPDATE`+`INSERT` atomicity** (A, should-fix). | §5 rewritten to state the mechanism explicitly: the guarded state `UPDATE` and the outbox `INSERT` run inside a single Postgres transaction (`BEGIN…COMMIT`) on one connection — a **real transaction**, not the bare-statement guarded-flip idiom used for inventory, because (unlike inventory) this path has no D1-portability requirement — `EmailSender`/the outbox are service-only. Failure windows are enumerated (none survive a crash before `COMMIT`; a crash after is indistinguishable from success and heals via the normal dispatcher claim) and a same-connection implementation constraint plus a forced-rollback contract test (5.5) are added so the atomicity claim is verified, not asserted. A secondary log-only drift check in the dispatcher is noted as defense-in-depth. |
| 3 | **Schema/column alignment with the canonical order schema** (task requirement, surfaced by re-reading revised Phase 4 §4). | Phase 5 referred to a nonexistent `orders.status` column throughout (types, endpoints, ports, tests); corrected to `orders.state` everywhere (§2, §5, §7, §8, §10). `orders.customer_id`'s previously ambiguous "added in Phase 4 or here — confirm during 5.1" note (flagged as a nit by both A and B) is resolved: Phase 4 already adds it forward-only; Phase 5 only populates it, restated in §3 and §4. Phase 5 introduces no order/order_item/order_totals columns, so no `_cents`/`_minor` drift was present or introduced. |
| 4 | **Magic-link enumeration/bombing test** (B, should-fix) and **admin-auth-exists assumption** (A, nit) — both already required as explicit tests/confirmations in the prior draft (Risk 4, Risk 7). | No change — reviewed and agreed the prior draft already treats both correctly (Risk 4 requires the test in 5.6, not just a comment; Risk 7 requires confirming admin auth at 5.1 kickoff). Kept as-is. |
| 5 | **Storefront "Block-Kit-free" claim asserted without an `emdash:` citation** (B, nit). | New Risk 9 (§9): confirm against EmDash platform source/notes before building 5.9; not expected to change the design, but should stop being an unsourced assumption. |
| 6 | **New observation while reconciling `expired`:** `pending → failed` still has no matching email template, now asymmetric with `pending → expired`. | Not from either review; noted as a new Risk 8 (§9) and explicitly left undesigned to keep this revision scoped to the requested fixes — flagged as a follow-up decision, not shipped silently. |

**Round 2 (re-review):**

| # | Finding (reviewer) | Resolution |
|---|---|---|
| R2-1 | **"adds the outbox insert to the existing transaction" is misleading** (Reviewer A New-6; Reviewer B New-5, nit) — Phase 4's `expireOrders` flip is a bare guarded statement, not a transaction, so there is no existing transaction to append to. | §5 "Wiring, not duplication" tightened: it now states plainly that Phase 5 **introduces** the transaction here, wrapping Phase 4's existing guarded `pending → expired` flip and the new outbox insert together — the mechanism is unchanged, only the wording is corrected so an implementer doesn't hunt for a Phase-4 transaction that doesn't exist. |

**Considered and not changed:** the two-port auth split, opaque DB-backed sessions, 404-not-
403 ownership checks, the `CustomerStore`/`AddressStore` customer-scoped port signatures, and
both draft ADRs (magic-link, service-sends-email) were endorsed by both reviewers and are
kept as-is. No finding was rejected.
