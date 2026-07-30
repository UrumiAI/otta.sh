---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Phase 5 — order lifecycle, storefront customers, and transactional emails.

- `@otta-sh/domain`: widens the `orders.state` machine (adds `processing`/`shipped`/`delivered`/
  `completed`/`cancelled`/`refunded` on top of Phase 4's `pending`/`paid`/`failed`/`expired`)
  as a single exported transition table + per-state email template map; a `transitionOrder`
  use-case enforcing legality in the domain (illegal ⇒ `INVALID_TRANSITION`, already-there ⇒
  idempotent no-op) and a `dispatchOrderEmails` outbox dispatcher. New ports: `CustomerStore`,
  `AddressStore` (customer-scoped signatures), `SessionStore`, `CustomerCredentialVerifier`,
  `EmailSender`; `OrderStore` gains `transition` (guarded flip + outbox insert), `listForCustomer`,
  `linkGuestOrders`, and outbox claim/mark methods. `requestLogin`/`verifyLogin` orchestrate the
  magic-link flow (first login creates the account, links matching guest orders, mints a session).
  New branded `CustomerId`/`Email` (normalized). In-memory fakes + five contract suites
  (`orderTransitionContract`, `customerStoreContract`, `addressBookContract`, `sessionContract`,
  `credentialVerifierContract`) + `FakeEmailSender`. Still IO-free.
- `@otta-sh/store-postgres`: migration `0006` (customers, addresses, customer_sessions,
  login_challenges, order_emails_outbox with `UNIQUE(order_id, to_state)`) and the four new Kysely
  adapters + the extended order store. The guarded state `UPDATE` and outbox `INSERT` run in one
  real transaction on one connection (exactly-once enqueue, proven by a forced-rollback contract
  case); the dispatcher claim is a lease-based conditional `UPDATE` (exactly-once claim — only one
  dispatcher ever wins a row). Delivery itself is at-least-once: a crash between `send()` and
  marking the row sent re-leases it for retry on a later tick; dedup down to effectively-once
  relies on the transactional-API provider's `Idempotency-Key` (wired in `HttpEmailSender`).
  Tokens are stored only as SHA-256 hashes. All contract suites run on SQLite + Postgres.
- `@otta-sh/service`: `POST /auth/login/request|verify`, `POST /auth/logout`, `GET /me`,
  `GET /me/orders(/:id)` (foreign id ⇒ 404, never 403 — no existence leak), `GET/POST/PUT/DELETE
  /me/addresses` (session-derived identity only, never a client-supplied id), `POST
  /admin/orders/:id/transition` (privileged), and `POST /internal/dispatch-emails`. The Phase-4
  webhook/expiry flips now also enqueue their status email atomically (no call-site rewrite —
  `markPaid`/`expire` route through the shared transactional primitive). Concrete `EmailSender`
  adapters (`ConsoleEmailSender`/`HttpEmailSender`) + a template renderer; the login-link email is
  wired.
- `@otta-sh/plugin`: PUBLIC storefront account routes (`/account/login/*`, `/account/orders`,
  `/account/order`, `/account/addresses`) — thin HTTP-only proxies over `ctx.http` to the `/auth`
  + `/me` surface, proven under the workerd-on-Node sandbox. No new capability beyond
  `network:request`/`allowedHosts`. Per the em-dash cookie-blindness verified in ADR-0003/cart
  routes, login returns a session-cookie descriptor for the theme's first-party layer and the
  bearer token is threaded in as route input.

Two draft ADRs recorded (proposed, pending sign-off): 0004 (magic-link customer auth) and 0005
(service sends transactional email directly).
