# 0047. AI agents shop through an in-process UCP surface and hand the shopper off to checkout

- Status: proposed
- Date: 2026-11-18

## Context

Shoppers increasingly start a purchase inside an AI agent (ChatGPT, Gemini, Claude, Perplexity).
The agent needs to search a store, build a cart and get the shopper to a place where they can pay.
Otta has nothing for this today:

- x402 (agents paying per request) was removed in #437 (commit 257b4ef2); ADR-0028 is withdrawn.
- The admin MCP work (ADR-0046, `docs/superpowers/specs/2026-11-17-otta-mcp-design.md`) lists
  "no storefront/shopper tools (cart, checkout)" as a non-goal, and EmDash plugin MCP tools can
  only point at **non-public** routes with an EmDash `permission`, behind admin consent and an
  API token. An anonymous shopper's agent can never reach them.

Urumi already built this for WooCommerce stores (wc-hosting-portal, `agents/agentic-service` and
`k8s_infra/plugins/urumi-agentic`): agents talk the Universal Commerce Protocol (UCP, version
2026-04-08) to a gateway, the gateway builds a real cart with the store's own prices, tax and
shipping, and returns a single-use **hand-off link**. The shopper opens it, lands on the store's
own checkout with everything pre-filled, and pays with the store's own gateway. The agent never
takes payment and never sees card data. That design needed a separate service because
WooCommerce runs in PHP on per-tenant pods; Otta is one deployable that owns commerce truth
in-process (ADR-0020).

Options considered:

1. **A separate agent gateway service** in front of the store (the WooCommerce shape). Its own
   hosting, auth and database for a store that is a single Worker. Rejected: it reintroduces the
   service ADR-0020 retired.
2. **Shopper tools through EmDash MCP.** Not possible without EmDash changes (non-public routes,
   admin consent, scoped tokens), and MCP-only would shut out agents that speak UCP over REST.
   Rejected.
3. **Payment inside the agent** (ACP delegated payment, AP2, x402 again). Needs PCI scope, per
   gateway tokenisation and per platform onboarding. Deferred, not rejected.
4. **An in-process UCP surface that ends in a hand-off to the store's checkout.** Same contract
   agents already get from Urumi's WooCommerce stores, no new deployable, no payment scope.

## Decision

1. **Option 4.** Otta serves UCP 2026-04-08 itself: a business profile at `/.well-known/ucp`,
   catalog search and lookup, checkout sessions (create, get, update, cancel, complete), order
   status, over REST and over an MCP (JSON-RPC) endpoint. The REST and MCP surfaces are site
   endpoints in `@urumi.ai/otta-store`; every commerce decision runs in the plugin through the
   same use-cases the storefront uses, so prices, stock holds, coupons, zones, shipping and tax
   are never re-implemented.
2. **The agent never completes payment.** `complete` answers `requires_escalation` with a
   `continue_url`. The shopper pays on the store's own `/checkout` with the store's configured
   payment methods (card or cash on delivery).
3. **The hand-off link is an opaque bearer token, single-use per browser,** that points at a checkout session
   held in plugin storage, stored only as a hash (as login links are, ADR-0004), and expiring
   after 24 hours. Because the session lives in the same store, the link carries no encrypted
   payload. The token rides in the URL fragment so it stays out of access logs.
4. **Prices are always taken fresh.** Opening a hand-off rebuilds or re-adopts the cart through
   the normal cart use-cases; the session's quoted totals are a preview, never a price promise.
5. **Off by default.** A merchant setting turns the agent surface on. While it is off every agent
   endpoint answers 404, and `/.well-known/ucp` is not served.
6. **Unsigned ("open tier") agents only, at first.** Every write needs an `Idempotency-Key`,
   per-IP and per-store limits apply through the existing rate-limit bindings, and order status
   needs the `order_secret` returned at session create. Verified agents (RFC 9421 HTTP message
   signatures) are a later decision.
7. **Agent orders are attributed.** An order placed from a hand-off records the agent channel and
   the checkout session id, so the merchant can filter agent orders and the agent can read status.
   Attribution covers orders placed before the session expires (24 hours after create); a
   later order is a normal, unattributed order.

## Consequences

- One protocol surface for Urumi: an agent that works with a Urumi WooCommerce store works with an
  Otta store, field for field where UCP defines the field.
- New public write endpoints. They join the rate-limit and origin-guard route maps (their
  default-deny tests force it), and a store that has not opted in exposes nothing.
- Agent checkout sessions hold shopper contact and address data. They are kept for at most 30 days
  (only once an order is recorded; every other session, handed off or not, purges an hour after
  it expires)
  and no account data export or erasure path exists for them yet: the 30-day purge sweep is the
  only deletion today. An export and erasure path that covers agent sessions is a precondition
  for enabling the merchant switch (`agentic.enabled`) on any store.
  Each session also keeps up to 32 earlier write answers for idempotent replay, and those are
  historical copies: a buyer or address a later update cleared survives in them until the session
  is purged. That future erasure must therefore delete the whole session document, never only its
  current fields.
- Session secrets are derived, not stored: the `order_secret` and each hand-off token are
  HMAC-SHA256 of the session id (and link generation) under a server key of at least 32 bytes,
  and the session keeps only their hashes. Rotating that key changes every derived secret.
  Replays that would re-derive one fail closed with `SECRET_KEY_MISMATCH` rather than hand out a
  secret that would not verify. A fresh update or complete whose unused link no longer re-derives
  mints a new link under the new key in the same write (the old link dies, as any replaced link
  does). The `order_secret` is a stable credential and is never re-issued: one a holder already
  has keeps verifying (verification compares hashes), but an agent that lost its create response
  cannot recover it after a rotation, so rotation strands the `order_secret` of every open session
  whose holder lost it.
- Accepted risk: a create's `Idempotency-Key` is scoped to the caller's network key (a hash of
  the client IP), because no session exists yet to scope it to. A create retried from a different
  egress IP, normal for cloud agents, is a fresh create and may leave a duplicate session (it
  expires unused). Every later write is scoped to the session id alone, which is already the
  bearer credential, so its retries replay from any network and never mint a second link.
- Redeeming a link is claim-then-finalize: a short lease (60 s) while the cart is built, then
  one compare-and-set that marks the link used and records the shopper's cart. The link is
  single-use PER BROWSER: the site sets a random nonce in an httpOnly cookie on the landing page,
  before any claim, and the domain keeps only its hash. Until finalized nothing binds the link: a
  claim that lapsed unfinalized may be claimed again by any browser (a transient failure, or a
  move from an in-app webview to another browser, never kills it). Once finalized only that
  browser may reopen it, for 15 minutes before any order and before the session expires; anyone else gets `HANDOFF_USED`. While a claim is live every redeem, the same
  browser's included, gets `HANDOFF_IN_PROGRESS` and the site waits and retries. Agent writes
  other than cancel wait while a claim is live; cancel always wins, and the claim's finalize
  then fails. No cart id is ever shown to the agent.
- Live agent sessions are bounded by slots taken at insert (500 per store, 50 per network key),
  using per-document compare-and-set only (ADR-0019); only a recorded order frees a slot, a
  hand-off or a cancel does not. Race-safety is REQUIRED of every adapter and proven by the
  contract suite's interleaving tests, which the EmDash adapter must pass. Sessions without an
  order are purged an hour after expiry, so stored sessions are at most 500 live plus at most
  500 per 24 hours ended without an order (50 per network key); sessions with an order keep 30
  days and are bounded by real orders. The per-document cap is 128 KiB (older replay answers evicted first). See the design spec's "Limits and abuse",
  including the accepted residual denial of service and the IPv6 /64 network-key requirement.
- Hand-off is terminal for the agent. Once a shopper redeems a link the shopper owns the cart:
  update, complete and issue-link are refused (`SESSION_HANDED_OFF`), so no second link can be
  minted for the same session and the shopper cannot be sent to pay twice. Only cancel (and reads)
  remain; an agent that needs changes after a hand-off creates a new session.
- Precondition on the plugin increment: at order placement from a redeemed link it MUST call
  `recordAgentSessionOrder`, which records the `orderId` (and the cart the order came from) and
  moves the session to `completed` by compare-and-set. It is idempotent for the same order, refuses
  a different one (`ORDER_ALREADY_RECORDED`) and refuses a session nobody redeemed
  (`HANDOFF_NOT_REDEEMED`). A completed session refuses every agent write (`SESSION_CLOSED`).
- Only products the storefront can sell are offered. Until the storefront exposes variants, a
  product with variants is listed with its default sku only.
- Deferred, each needing its own decision: verified agent signatures, ACP (ChatGPT) carts and
  product feed, order webhooks to agent platforms, and payment inside the agent.
- The admin MCP non-goal stands: this ADR adds shopper-facing protocol endpoints, not EmDash MCP
  tools.
