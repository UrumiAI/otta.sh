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
3. **The hand-off link is an opaque, single-use bearer token** that points at a checkout session
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

## Consequences

- One protocol surface for Urumi: an agent that works with a Urumi WooCommerce store works with an
  Otta store, field for field where UCP defines the field.
- New public write endpoints. They join the rate-limit and origin-guard route maps (their
  default-deny tests force it), and a store that has not opted in exposes nothing.
- Agent checkout sessions hold shopper contact and address data. They are kept for at most 30 days
  and are covered by the account data export and erasure paths.
  Each session also keeps up to 32 earlier write answers for idempotent replay, and those are
  historical copies: a buyer or address a later update cleared survives in them until the session
  is purged. Erasure therefore deletes the whole session document, never only its current fields.
- Session secrets are derived, not stored: the `order_secret` and each hand-off token are
  HMAC-SHA256 of the session id (and link generation) under a server key of at least 32 bytes,
  and the session keeps only their hashes. Rotating that key invalidates every outstanding
  `order_secret` and link for any path that re-derives them (replays, `complete`, any answer
  carrying the current link): those fail closed with `SECRET_KEY_MISMATCH` rather than hand out a
  secret that would not verify. A secret or link a holder already has keeps verifying, and a new
  link can be issued under the new key; a lost `order_secret` cannot be re-issued.
- Accepted risk: a create's `Idempotency-Key` is scoped to the caller's network key (a hash of
  the client IP), because no session exists yet to scope it to. A create retried from a different
  egress IP, normal for cloud agents, is a fresh create and may leave a duplicate session (it
  expires unused). Every later write is scoped to the session id alone, which is already the
  bearer credential, so its retries replay from any network and never mint a second link.
- Precondition on the plugin increment: at order placement from a redeemed link it MUST record the
  `orderId` on the session and move the session to `completed`. The domain already refuses
  update, complete, issue-link and cancel on a completed session (`SESSION_CLOSED`); until the
  plugin does this, a later update or complete would mint a new link after an order was placed,
  so the guard against paying twice rests on that increment.
- Only products the storefront can sell are offered. Until the storefront exposes variants, a
  product with variants is listed with its default sku only.
- Deferred, each needing its own decision: verified agent signatures, ACP (ChatGPT) carts and
  product feed, order webhooks to agent platforms, and payment inside the agent.
- The admin MCP non-goal stands: this ADR adds shopper-facing protocol endpoints, not EmDash MCP
  tools.
