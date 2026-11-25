# Otta agentic checkout — design

Status: proposed 2026-11-18 · ADR-0047 · branch `docs/agentic-checkout-design`

## Intent

A shopper asks an AI agent ("find me a ceramic mug under $30 and get it to Austin"). The agent
finds the product in an Otta store, builds the cart with the shopper's address and coupon, and
gives the shopper one link. The shopper opens it, lands on the store's own checkout already filled
in, and pays the way the store takes payment. The merchant sees the order tagged as an agent order.

Urumi already does this for WooCommerce stores through a UCP gateway service and a hand-off
plugin. Otta should offer the **same agent-facing contract**, built in-process (ADR-0020), reusing
the storefront's cart, pricing and order code rather than a second implementation.

## Goals

- An agent can discover the store, search and look up products, create and update a checkout
  session (lines, buyer, shipping address, shipping option, coupon), get totals, and get a
  `continue_url`, over UCP 2026-04-08 REST and over MCP.
- Opening `continue_url` puts the shopper on `/checkout` with the cart, email, address, shipping
  method and coupon already applied, at current prices.
- The resulting order is attributed to the agent channel and readable by the agent with its
  `order_secret`.
- Off by default per store; nothing new is reachable until the merchant turns it on.

## Non-goals

- Payment inside the agent (ACP delegated payment, AP2, x402). Later decision.
- Verified agent signatures (RFC 9421). Later; every agent is open tier in this work.
- ACP (ChatGPT) carts and the OpenAI product feed. Later.
- Order webhooks to agent platforms. Later; agents poll `get_order`.
- Selling variants. The storefront does not sell them yet; see constraints.
- EmDash MCP tools. Those stay admin-only (ADR-0046).

## Anti-goals (a failure even if it "works")

- Any price, discount, tax or shipping figure computed outside the domain's quote and order code.
- A hand-off that trusts a price, total or stock level from the session instead of re-reading.
- Shopper data (email, phone, address) in logs, in URLs that reach the server, or returned to a
  caller that does not hold the session.
- A link that can be replayed, or that silently empties or overwrites a shopper's existing cart
  when none of its lines can be added.
- A new write endpoint missing from the rate-limit or origin-guard maps.
- Money as floats. Minor units plus currency everywhere, as UCP itself requires.

## Constraints found in the code (origin/main 83fb9a65)

1. **Catalog queries run in the site**, not the plugin: `getEmDashCollection("products")` in
   `sites/store/src/pages/products/index.astro`; the plugin only prices and stocks what it is given
   (`storefront/list`, max 48; `storefront/product`). Agent catalog search therefore lives in the
   site and joins through the same plugin routes.
2. **The cart does not store coupon, destination or shipping method.** They are passed on each
   `quoteCheckout` / `storefront/checkout/summary` call (`lib/checkout-selection.ts`). A checkout
   session must hold them itself.
3. **Cart holds expire** (`DEFAULT_HOLD_TTL_MS` 15 min, settings `holdTtlMinutes`). A session may be
   opened hours later, so the hand-off must cope with an expired or checked-out cart by rebuilding.
4. **Plugin routes cannot set cookies** (ADR-0003); they return `CartCookieDescriptor` and the site
   applies it. The hand-off endpoint must be a site endpoint.
5. **Checkout draft** (email, address) lives in the `otta_checkout_draft` cookie (HttpOnly, Strict,
   `/checkout`, 15 min). Pre-fill writes that cookie.
6. **Variants** are admin-only; a variant sku does not resolve to a product for pricing. v1 offers
   simple products; a product with variants is listed as one item at its default sku.
7. **Rate-limit and origin maps are default-deny by test** (`sites/store/test/rate-limit.test.ts`,
   `test/origin-middleware.test.ts`). The origin guard passes a request with no `Origin`, which is
   what agents send.
8. **Orders have no attribution field** today (`packages/domain/src/orders/model.ts`). Tagging needs
   a small domain addition.

## Design

### Where things live

| Layer | Owns |
|---|---|
| `packages/domain` | `AgentCheckoutSession` model, session use-cases (create/update/get/cancel/complete), hand-off token issue + redeem, order attribution field. No IO. |
| `packages/store-emdash` | `AgentSessionStore` adapter over `ctx.storage` (compare-and-set, as the other stores) with hashed token index and a TTL sweep. |
| `packages/plugin` | Public routes `agentic/session/{create,get,update,cancel,complete}`, `agentic/handoff/redeem`, `agentic/order`; `agentic.enabled` setting and the Block Kit switch; cron sweep; agent filter on the orders page. |
| `sites/store` | UCP: `/.well-known/ucp`, `/ucp/v1/catalog/{search,lookup}`, `/ucp/v1/checkout-sessions[/{id}[/complete|/cancel]]`, `/ucp/v1/orders/{id}`, `/ucp/v1/mcp`; the hand-off page `/checkout/handoff`. Maps UCP JSON ⇄ plugin route results. |

One store per deployment, so there is no `{slug}` in paths (the WooCommerce gateway's
`/ucp/v1/stores/{slug}` collapses to `/ucp/v1`).

### Checkout session

```
AgentCheckoutSession {
  id: "cs_<random>"; status: "incomplete" | "requires_escalation" | "completed" | "canceled"
  currency; lines: [{ productId, sku, quantity }]
  buyer?: { email?, firstName?, lastName?, phone? }
  destination?: ShippingAddress (ADR-0009 shape); shippingMethodId?; couponCode?
  cartId?          // the agent's cart, last used to quote; may expire; never projected
  shopperCartId?   // the shopper's cart, recorded at finalize; never projected
  quote?           // last computed totals, a preview only
  orderSecretHash; handoffTokenHash?; handoffUsedAt?; orderId?
  channel: "other"; createdAt; expiresAt (createdAt + 24 h)
  purgeAt          // expiresAt + 1 h, handed off or not; createdAt + 30 d once an order is
                   // recorded; max(now, expiresAt) + 1 h on cancel of a session never handed off
}
```

- **create / update** (full replacement, as UCP `PUT`): validate lines against the plugin's
  pricing (`getCommerceBatch`), create a cart with a session-derived idempotency key, add the
  lines through `addCartLine`, then `quoteCheckout` with destination, shipping method and coupon.
  Map refused lines and coupon refusals to UCP `messages[]`. Status is `incomplete` with no lines,
  else `requires_escalation`, and the response carries `continue_url`.
- **Idempotency:** every write requires `Idempotency-Key` (1–255 characters); the same key and
  body replay the stored answer, a different body is `409 idempotency_key_reused` (UCP semantics,
  and Otta's own rule). A key is bound to its operation: reusing it for another operation
  (create, update, complete, cancel, issue-link) is `idempotency_key_reused` too. A refused write
  records nothing, so its key may be retried with a corrected body. Keys live as long as the
  session's retention: a session or create record at or past `purgeAt` replays nothing
  (`IDEMPOTENCY_KEY_EXPIRED`, never a re-create), and once the sweep deleted it the key is fresh.
  A create record follows its session's retention: it is moved out to 30 days when an order is
  recorded. A create racing another create of the same key whose insert is still in flight
  answers the retryable `WRITE_CONFLICT` (the store will not release or adopt a record whose
  session holds a live slot); its retry replays. A create's key is scoped to the caller's network key (no session exists
  yet), so a create retried from another egress IP may duplicate the session (accepted, ADR-0047);
  every later write is scoped to the session id alone and replays from any network.
- **Public view:** every result the site sees carries `AgentSessionView`, an allowlist projection:
  `id, status, currency, lines, buyer?, destination?, shippingMethodId?, couponCode?, quote?,
  expiresAt, orderId?, handedOff`. No cart id (neither the agent's nor the shopper's: a cart id
  is the shopper's cart cookie), idempotency records, network key, secret hashes, link generation
  or history, revision or purge time; stored write answers and replays are projected the same
  way. A write's `handoffToken` is always the
  CURRENT live link, also on a replay whose stored answer is older; `get` returns it too while it
  is unused, unexpired and re-derives under the current key. The site builds `continue_url` only
  from that token, never from session fields.
- **Content caps:** buyer and address fields at most 256 characters, `couponCode` 64,
  `shippingMethodId` and `cartId` 128; an empty fingerprint or network key is refused
  (`INVALID_REQUEST`).
- **Quote:** the plugin's verbatim preview from the domain pricing code; the session stores it
  unchecked (it refuses only another currency or a total beside an unknown part).
- **Hand-off is terminal for the agent:** once a link is redeemed the shopper owns the cart, and
  update, complete and issue-link are refused `SESSION_HANDED_OFF` (no second link, no double
  pay). Cancel and get remain; for changes the agent creates a new session.
- **Completion (plugin increment precondition):** placing an order from a redeemed link MUST call
  `recordAgentSessionOrder({sessionId, orderId, cartId?})`: compare-and-set to `completed` with
  `orderId`; idempotent for the same order, `ORDER_ALREADY_RECORDED` for another,
  `HANDOFF_NOT_REDEEMED` if no link was redeemed. A completed session refuses every agent write
  (`SESSION_CLOSED`). **Attribution covers only orders placed before the session expires (24 h
  after create):** from `expiresAt` a new order is `SESSION_EXPIRED` and is not attributed (a
  replay of the recorded one still answers). Recording the order frees the session's live
  slots and moves it, and its create record, to the 30-day retention.
- **complete** never takes payment: it returns the session with `requires_escalation` and
  `continue_url` (UCP `buyer_handoff_required` message).
- **cancel** releases the cart's holds and marks the session canceled; a canceled session's link
  is dead. Cancel is always allowed, also while a hand-off claim is live; that claim's finalize
  then fails `HANDOFF_CANCELED`. A canceled session purges an hour after it expires; a cancel
  never moves a handed-off session's purge (a session with an order cannot be canceled).
- **get_order**: `{id, checkout_id, status, updated_at}` for the session's order, requiring the
  `order_secret` (header `Urumi-Order-Secret` or MCP `order_secret`), compared in constant time.

### Hand-off link

- `continue_url = https://<store>/checkout/handoff#<token>`, `token` = HMAC-SHA256 of the session
  id and link generation under a server key of at least 32 bytes, base64url (the `order_secret` is
  derived the same way). Only `sha256(token)` is stored on the session; issuing a new link replaces
  the hash. A re-derived secret is checked against its stored hash before it is returned. After a
  key rotation, replays fail closed (`SECRET_KEY_MISMATCH`) instead of handing out dead links; a
  fresh update or complete whose unused link no longer re-derives mints a new link under the new
  key in the same write and returns it. The `order_secret` is never re-issued: rotation strands it
  for any open session whose agent lost its create response (one it holds still verifies).
- `GET /checkout/handoff` is a static, `no-store` page. It sets the browser's **redeemer nonce**
  cookie (random, httpOnly, `SameSite=Lax`, `Secure`) if absent, BEFORE any claim, so a lost
  response to the first POST never strands the link. An inline script keeps only the
  leading token characters of the fragment (agents and chat apps append `?utm_…`, `&…` or a
  trailing period: lesson from WooCommerce #4588), clears the fragment with `replaceState`, and on
  "Continue" POSTs the token same-origin.
- `POST /checkout/handoff` (site) calls plugin `agentic/handoff/redeem` with the token and the
  redeemer nonce from that cookie; the domain stores and compares only the nonce's hash. A POST
  without the cookie (blocked or cleared cookies) is refused `HANDOFF_REDEEMER_MISSING`
  (retryable): the site reloads the landing page, which sets it, and the shopper continues.
  The plugin CLAIMS the link with a 60 s lease (`claimAgentHandoff({token, redeemer})`; the link
  is not used yet), then:
  1. builds the shopper a FRESH cart, never the agent's: the cart id is random, and the cart's
     CREATE (idempotency) KEY is HMAC(server key, session id + token), so a retried redeem of the
     same link lands on the same cart, and the
     session's lines are re-added to it (prices and stock re-read);
  2. if **no** line can be added, releases the claim (`releaseAgentHandoffClaim`, the link stays
     redeemable), leaves the shopper's existing cart cookie untouched and shows why (lesson from
     #4596);
  3. otherwise FINALIZES (`finalizeAgentHandoff`): one compare-and-set marks the link used,
     records the shopper's cart as `shopperCartId` (never shown to the agent), releases the
     agent's cart (the session's `cartId`; the agent never sees the shopper's cart, nor the
     shopper the agent's), then returns the cart cookie descriptor plus the pre-fill
     (email, phone, address, shipping method, coupon). Finalize is refused
     (`HANDOFF_CLAIM_LOST`) once the claim was replaced or its lease lapsed more than 30 s ago,
     and (`HANDOFF_EXPIRED`) at or after `expiresAt`; the plugin then does not hand that cart
     over.
  **The link is single-use per browser.** Until it is finalized nothing binds it: a claim that
  lapsed without finalizing (a lost response, a crash, a move from an in-app webview to Safari)
  may be claimed again by ANY browser. Once finalized, only the browser that finalized it (same
  nonce) may reopen it, for 15 minutes, before any order and before `expiresAt` (from then it
  is `HANDOFF_EXPIRED`, as no order could be attributed any more): `claimAgentHandoff` answers
  `reentered` with `shopperCartId` and `handoffUsedAt` and writes nothing. Any other holder of
  the token (the agent included) gets `HANDOFF_USED`. While a claim is live
  EVERY redeem, the claiming browser's included (double click, second tab), answers
  `HANDOFF_IN_PROGRESS`: the site shows a short wait and retries (e.g. after 2 s, up to the
  lease). On `reentered` the plugin MUST check that `shopperCartId` has not already been
  converted to an order (a checkout can place it before `recordAgentSessionOrder` lands); if it
  has, it answers as `HANDOFF_USED`. Agent writes other than cancel wait while a claim is live
  (`HANDOFF_IN_PROGRESS`); an agent write after a lapse clears the stale claim, whose late
  finalize is then `HANDOFF_CLAIM_LOST`. A store that cannot fit the claim or finalize in the
  document answers `HANDOFF_UNAVAILABLE`.
  The site sets `otta_cart`, writes `otta_checkout_draft`, and 303s to `/checkout?coupon=…&country=…
  &region=…&method=…` (the selection params `/checkout` already reads).
- Pre-fill never overwrites what a signed-in customer already has on their account, and the link's
  email and address are never saved to an account (lesson from #4592, #4593, #4599).
- Reopening a used link in the same browser goes to `/checkout`; elsewhere it shows "this link was
  already used"; the assistant must start a new session for a new link (a redeemed session takes
  no new link).

### Order attribution

`Order` gains an optional `attribution { channel: "agent"; via: "handoff"; sessionId }`, set at
place time when the cart came from a redeemed hand-off (the redeem marks the cart). The admin
orders page gets an "Agent orders" filter. Order status read by the agent is the order's status only;
no shopper data is returned.

### UCP mapping

- Profile (`/.well-known/ucp`): `version 2026-04-08`; capabilities `dev.ucp.shopping.checkout`,
  `.fulfillment` (extends checkout), `.discount` (extends checkout), `.order`,
  `.catalog.search`, `.catalog.lookup`; `payment_handlers: {}`; services `dev.ucp.shopping`
  REST at `/ucp/v1` and MCP at `/ucp/v1/mcp`. `Cache-Control: public, max-age=300`.
- Catalog: `search {query?, filters{categories, price{min,max}}, pagination{cursor, limit≤50}}`,
  `lookup {ids≤20}`; product `{id, title, description{plain}, url, price_range, media[],
  variants[{id, title, price{amount,currency}, sku, availability{available,status}}]}`. Only
  published products with a price in the session currency are returned.
- Checkout fields, totals types (`subtotal`, `discount` negative, `fulfillment`, `tax`, `total`),
  `messages[]` codes, error envelope `{code, content}` and HTTP statuses follow the WooCommerce
  gateway (wc-hosting-portal `agents/agentic-service/internal/gateway/ucp`), so one agent client
  works for both. Discount: one code applied; extra codes get `discount_code_combination_disallowed`.
- MCP: JSON-RPC 2.0, protocol `2025-06-18`, plain JSON responses, 64 KiB body cap; tools
  `search_catalog`, `lookup_catalog`, `create_checkout`, `get_checkout`, `update_checkout`,
  `complete_checkout`, `cancel_checkout`, `get_order`.

### Limits and abuse

- New site routes join `SITE_ROUTES` on the existing bindings: reads on a new `RATE_LIMIT_READS`
  binding (or exempt if the binding is unavailable on Workers Free; decide in the site PR), writes
  on `RATE_LIMIT_WRITES`, keyed per IP.
- Per-store caps on live sessions, enforced by the store at insert with per-document
  compare-and-set only (ADR-0019: no transactions, no counters). The store keeps **live slots**:
  a cap of N is N slot documents; an insert compare-and-sets a free slot in its network's pool
  (default **50 per network key**) and then in the store-wide pool (default **500**), writes the
  session (not yet visible to any read), then compare-and-sets a `landed` mark onto both slots
  and makes the session visible. A slot is free when absent, expired, or ABANDONED: never
  landed, taken more than 60 s ago, and its session document absent. Probes read a session only
  for such an old unlanded slot; landed slots skip the read. A slot whose session was written is
  therefore never retaken before its expiry, whether its insert stalled or crashed between the
  write and the marks; a replay of the create, or the slot sweep, lands the marks later. Only a
  slot taken before its session was written can be lost; that insert drops its never-visible
  session and answers `capacity`, so no caller ever saw a session that is then deleted. A hidden
  session stranded past expiry (no replay, no sweep) is deleted by the probe that retakes its
  slot, and otherwise by the session purge at its `purgeAt`, so it never escapes the storage
  bound.
  A slot is held until the session's `expiresAt`, EXCEPT that a recorded order frees it at
  once; a hand-off and a cancel free nothing, so neither a create-cancel nor a create-redeem
  loop can outrun the cap. A refused create is `TOO_MANY_SESSIONS` and leaves no create record behind.
  Before probing, `createAgentSession` refuses early from the count of OCCUPIED slots (canceled
  sessions' included), so a full pool costs no probe. Per-network creates (default 60 per hour)
  stay a soft count. All are tunable limits.
  **Race-safety is required of every adapter, not assumed:** the contract suite runs its racing
  inserts, claims, finalizes, releases and stalled inserts against a store whose every read and
  write yields to the other callers, and a check-then-insert store fails it (shown in the review
  evidence). The EmDash adapter in #712 must pass that suite before it merges.
- **The real ceilings.** Concurrently: at most 500 unexpired sessions without an order
  store-wide (50 per network key), canceled and handed-off ones included. Per rolling 24 h: at
  most 500 sessions store-wide (50 per network key) that end abandoned, canceled or handed off
  with no order, since their slots recycle only at expiry. Only a recorded order frees a slot
  early, so only placed orders can push throughput past that, and see the trade-off below.
- **Per-create cost and why 500, not 5,000:** an early refusal is one count of occupied slot
  documents (an indexed count in an adapter). An admitted insert reads its own session id once
  (exists?), probes slot documents from a hashed offset, about 1/(1 − occupancy) reads per pool,
  worst case 50 + 500 slot reads, then does two slot compare-and-sets, the hidden session write,
  two `landed` marks (each a read and a compare-and-set) and the admitting compare-and-set. A
  probe also reads a session for each unlanded slot older than 60 s it meets (rare: only a
  crashed or stalled insert leaves one), and deletes it if it retakes an expired one. At
  5,000 the worst case would be ten times that for every create near a full pool; 500
  concurrent unexpired agent checkouts is far above what a store on this stack sees, and the
  limit is tunable per store.
- **Lowering a cap** takes effect at once for the early refusal (it counts occupied slots at any
  index) and within 24 h for the atomic check: slots at or beyond the new size are no longer
  probed and expire with their sessions.
- **Storage bound (a real cap):** every session without an order, handed off or not, is purged
  1 h after it expires. Stored sessions are therefore at most the 500 live ones plus at most
  500 per 24 h that ended abandoned, canceled or handed off with no order (50 per network key),
  awaiting their 1 h purge: about 1,000 at once, ≈ 125 MiB at the 128 KiB document cap. Only
  sessions with a recorded order are kept 30 days. **Known trade-off:** a recorded order need
  not be a paid one: cash-on-delivery orders are placed unpaid, so an abuser who completes
  checkouts with cash on delivery frees a slot per order and leaves a 30-day session (and an
  unpaid order) behind each time. That path is limited only by the per-network create rate (60
  per network key per hour, a soft count) and the site's write rate limit, not by the slots;
  each such session also leaves an order the merchant sees and can cancel. Slot documents are deleted by version when their session is purged or its order
  recorded, and by the sweep (`purgeSlotsDue`, run
  from the same cron as the session purge) once expired or abandoned, so they stay at about
  2 × 500 held plus those expired since the last sweep, however network keys rotate.
- **Residual denial of service (accepted, documented):** 10 network keys (500 / 50) can hold
  every live slot, refusing new agent checkouts store-wide, for 24 h per round of creates.
  Shoppers and the normal storefront are unaffected. The per-network cap only means something if
  a network key is hard to multiply: **#712 must aggregate IPv6 clients to their /64 when
  deriving `networkKey`** (one host typically owns a whole /64), and IPv4 to the address.
- Per-session storage is bounded: 50 lines; product id and sku at most 128 characters each; the
  content (the public view) at most 32 KiB as UTF-8 JSON (`CONTENT_TOO_LARGE`); order id at most
  128 characters; and the whole stored document at most 128 KiB (UTF-8 JSON, the store refuses
  heavier, `too_large`). Keyed writes keep 4 KiB under that by evicting their oldest kept write
  answers early (the evicted keys retire: a late replay is `IDEMPOTENCY_KEY_EXPIRED`), so a
  cancel and the hand-off marks always fit; a write that cannot fit even alone is
  `WRITE_LIMIT_REACHED`. At most 32 kept answers and 512 keyed writes per session.
- Body cap 64 KiB; at most 50 lines, quantity 1–`CART_LINE_MAX_QTY`.
- Every agent-created cart holds stock for the normal hold TTL only; abandoned sessions cost no
  stock after that.

### Settings

`agentic.enabled` (default `false`), shown on the Settings page with a short explanation. While
false, every agent route and `/.well-known/ucp` answer 404.

### Privacy

- Sessions are swept at `purgeAt` (cron, bounded per tick like `prune-carts`): 1 h after expiry,
  or 30 days after creation if an order was recorded.
- No account data export or erasure path exists for sessions yet; the 30-day purge sweep is the
  only deletion today. An export and erasure path covering sessions (found by buyer email) is a
  precondition for enabling the merchant switch (`agentic.enabled`) on any store. When it lands,
  erasure must delete the whole session document: its kept write answers hold earlier copies of
  the buyer and address until the session is purged.
- Logs carry session ids and outcome codes only.

## Delivery (one PR each, in order, each merges before the next starts)

1. `[Docs]` this spec + ADR-0047.
2. `[Domain]` session model and use-cases, token issue/redeem, order attribution; contract tests.
3. `[Adapters]` `AgentSessionStore` on EmDash storage (SQLite, Postgres, D1 per repo rules).
4. `[Plugin]` routes, setting + Block Kit switch, sweep cron, agent order filter.
5. `[Site]` UCP REST + profile + rate-limit/origin map entries.
6. `[Site]` hand-off page and redeem endpoint; e2e: agent creates session → shopper opens link →
   checkout pre-filled → COD order placed → `get_order` reads it.
7. `[Site]` MCP endpoint over the same handlers.

Each PR runs the standard battery (`pnpm lint && pnpm format:check && pnpm typecheck && pnpm -r build
&& pnpm test`, `test:pg`, `test:d1`, `test:e2e`, and `test:pack-types` / `test:pack-build` when
`packages/` or `sites/store` change) and records it in the PR body.

## Left to the builder

Exact UCP JSON field coverage beyond the fields above, the read rate-limit binding choice on Workers
Free, the session id and token alphabets, the copy on the hand-off page, and whether the agent
filter is a tab or a select on the orders page.

## Calls made (please check)

- In-process, no separate service; same UCP contract as the WooCommerce gateway.
- Opaque hashed token instead of the WooCommerce AES-GCM payload token (state is local).
- Open tier only, off by default; signatures, ACP, webhooks and in-agent payment deferred.
- Simple products only until the storefront sells variants.
- Session retention 30 days only with an order (else 1 h after the 24-hour expiry); link life 24
  hours; attribution only for orders placed within those 24 hours.
