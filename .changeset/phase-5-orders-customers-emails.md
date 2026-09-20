---
"@otta-sh/domain": minor
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
  `credentialVerifierContract`) + `FakeEmailSender`. Still IO-free. The guarded state flip and
  the outbox insert are one atomic unit (exactly-once enqueue, proven by a forced-rollback
  contract case) and the dispatcher claim is a lease (only one dispatcher ever wins a row);
  delivery itself is at-least-once — a crash between `send()` and marking the row sent re-leases
  it for retry on a later tick, and dedup down to effectively-once relies on the transactional
  email provider's `Idempotency-Key`. Session and login tokens are stored only as SHA-256
  hashes. The Phase-4 paid/expiry flips now enqueue their status email atomically too, with no
  call-site rewrite — `markPaid`/`expire` route through the same transactional primitive.
- `@otta-sh/plugin`: PUBLIC storefront account routes (`/account/login/*`, `/account/orders`,
  `/account/order`, `/account/addresses`) over the auth + account surface, proven under the
  workerd-on-Node sandbox. A foreign order id reads as not-found, never forbidden (no existence
  leak), and an address is always resolved from the session's identity, never from a
  client-supplied id. Per the em-dash cookie-blindness verified in ADR-0003/cart
  routes, login returns a session-cookie descriptor for the theme's first-party layer and the
  bearer token is threaded in as route input.

Two draft ADRs recorded (proposed, pending sign-off): 0004 (magic-link customer auth) and 0005
(the transactional email transport).
