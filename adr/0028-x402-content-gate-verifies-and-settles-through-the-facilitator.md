# 0028. The x402 content gate answers 402 itself and settles through the facilitator's `/verify` and `/settle`

- Status: accepted
- Date: 2026-10-05
- Decided by: the product owner, 2026-10-05 (issue #376 part 2): standard x402, digital products
  only, USD stores first, USDC on Base, access re-checked on every download, and a full refund
  revokes it. The two questions left open in the first draft were answered on 2026-10-06: live
  payments use any facilitator that takes no credential or a static API key (Decision 7), and a
  lost `/settle` answer is flagged for a manual check, with no chain read in v1 (Decision 5).
- Refines: [ADR-0008](./0008-order-refunds.md) (x402 refunds stay manual and recorded; this record
  says what "refund" means for a gate order). Builds on [ADR-0011](./0011-entitlement-check-authentication.md)
  (the `orderId` scope is how an agent downloads again) and [ADR-0020](./0020-one-deployable-plugin-owns-commerce-truth.md)
  (the facilitator is reached over `ctx.http` within the build-time `allowedHosts`).
  [ADR-0026](./0026-admin-order-actions-never-claim-money-that-did-not-move.md) is unchanged:
  x402 stays a `"gateway"` method for settlement and an `"outside"` method for refunds.
- Supersedes: the phase-4 plan's §6 x402 flow, steps 2–3, and its "page-gate bypass" that
  created an order on the first 402 (`plans/archive/phase-4-checkout-and-gateways.md:448-505`).
  It also retires the receipt-forwarding model of `@otta-sh/payments-x402`.
- Moots: the clause in ADR-0005's first 2026-10-02 amendment that names `entitlements/x402/settle`
  as an inline-email caller. That route is retired (Decision 9), and a gate order has no email
  address (Decision 6).
- Numbering: 0027 is reserved by the tax-engine branch stack (`feat/tax-engine`, `tax/1-engine`
  and later), which lands it separately.
- Spec: x402 as of `coinbase/x402@dd927a26` (2026-04-21). Citations are to
  `specs/x402-specification-v2.md` ("v2 §n"), `specs/x402-specification-v1.md` ("v1 §n"),
  `specs/transports-v2/http.md` and `specs/transports-v1/http.md` ("HTTP v2" / "HTTP v1"), and
  `specs/schemes/exact/scheme_exact_evm.md` ("exact-EVM").

## Context

Issue #376 asks for an x402 content gate: an agent or a person asks for a digital product, is told
the price with an HTTP 402, pays in USDC, and gets the file in the same exchange. The design note
for #376 (§4) found that the repo has x402 pieces, but they do not fit the protocol.

**What the protocol does** (v2 §2, §5, §7; HTTP v2):

1. The resource server answers **402** with a `PaymentRequired` object: `x402Version: 2`, a
   `resource`, and `accepts[]`, a list of `PaymentRequirements`
   `{scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra}` (v2 §5.1.2). `amount` is a
   string in the asset's atomic units, and `network` is CAIP-2 (v2 §11.1). Over HTTP the object is
   sent base64-encoded in a `PAYMENT-REQUIRED` header (HTTP v2, "Payment Required Signaling").
   v1 sent it as the JSON body, named the amount `maxAmountRequired`, and used network names such
   as `base` (v1 §5.1.2; HTTP v1).
2. The client sends the request again with a `PaymentPayload` in a **`PAYMENT-SIGNATURE`** header
   (HTTP v2, "Payment Payload Transmission"). v1 used **`X-PAYMENT`** (HTTP v1). The payload
   carries `accepted` (the requirements it chose) and, for `exact` on EVM, `payload.signature`
   plus an EIP-3009 `authorization` `{from, to, value, validAfter, validBefore, nonce}`
   (v2 §5.2.2; exact-EVM §1, "Phase 1").
3. **The resource server** calls the facilitator: **`POST /verify`** with
   `{x402Version, paymentPayload, paymentRequirements}`, which answers
   `{isValid, invalidReason?, payer?}` (v2 §7.1, §5.4). Then it calls **`POST /settle`** with the
   same body, which answers `{success, errorReason?, payer?, transaction, network, amount?}`
   (v2 §7.2, §5.3). The settlement goes back to the client in a **`PAYMENT-RESPONSE`** header
   (HTTP v2, "Settlement Response Delivery"). v1 named it **`X-PAYMENT-RESPONSE`** (HTTP v1).
4. **`exact` on EVM with USDC** settles by calling `transferWithAuthorization` on the token
   contract (v2 §6.1.3; exact-EVM §1, "Phase 3"). The signature fixes the amount and the
   destination: "the Facilitator cannot modify the amount or destination" (exact-EVM, Summary).
   Replay protection is the EIP-3009 nonce. The token contract refuses a nonce it has already
   used (v2 §10.1). The facilitator's checks are listed in v2 §6.1.2 and exact-EVM §1 "Phase 2",
   and its error codes in v2 §9, among them `invalid_exact_evm_payload_recipient_mismatch` and
   `invalid_exact_evm_payload_authorization_value_mismatch`.

**What the repo has instead:**

- `@otta-sh/payments-x402` uses a **receipt-forwarding** model. Its challenge is
  `{kind: "x402_challenge", accepts, price: Cents, payTo}` (`packages/payments-x402/src/index.ts:135-143`,
  `packages/domain/src/ports/payment-gateway.ts:329`). It names no asset and no atomic amount.
  The "proof" is a settle response that something else obtained, plus a `signature`
  (`payment-gateway.ts:345-356`). `createHttpFacilitator` posts that proof to one custom endpoint
  and expects `{valid: true}` back (`index.ts:296-364`). No standard facilitator has that
  endpoint. The only facilitator that can produce `signature` is the offline HMAC test one
  (`index.ts:386-419`).
- **The recipient check is missing.** The adapter never checks that the money went to our
  `payTo`. Its own header says so (`index.ts:38-46`), and so does #282 item 1.
- **`entitlements/x402/settle` has no caller.** The route (`packages/plugin/src/payments/x402-settle-route.ts:96`,
  registered public at `packages/plugin/src/plugin.ts:221-224`) settles an existing order whose
  `paymentMethod` is `"x402"` (`x402-settle-route.ts:336-340`). Checkout never creates one,
  because it hardcodes `PAYMENT_METHOD = "stripe"`
  (`packages/plugin/src/storefront/checkout-routes.ts:101`, used at `:651`; #282).
- The phase-4 plan assumed an `@emdash-cms/x402` Astro integration exposing `Astro.locals.x402`.
  No such package is installed, and emdash 0.38 has no x402 code (design note §4).

**What we can reuse:**

- The domain's settlement path. `settleOrder` refuses a dedupe key that is already bound to a
  different order (`RECEIPT_REBOUND`, `packages/domain/src/orders/settle-order.ts:105-127`).
  It requires the amount and currency to equal the order total (`:196-208`). It grants one
  entitlement per digital line with `source: "x402"` (`:320-334`).
- The configuration. The facilitator URL is a build-time define, `X402_FACILITATOR_URL`
  (`sites/staging/astro.config.ts:59`, baked at `:234`), and its host is the only x402 entry in
  `ALLOWED_HOSTS` (`packages/plugin/src/manifest.ts:97-104`, `:173`). `payTo` and the accepted
  networks are readable kv (`packages/plugin/src/payments/x402-wiring.ts:64-73`), shape-checked
  by `isPlausiblePayTo` (`:182-186`). The facilitator credential is write-only kv
  (`settings:x402FacilitatorApiKey`, `packages/plugin/src/payment-secrets.ts:83`).
- The download work in #376 part 1 (design note §3). After downloads increments 1 and 2,
  `entitlements/download` returns the file descriptor only when four checks pass: the grant is
  active, the order is deliverable, the product is digital, and the asset is valid. A full refund
  revokes the grant on every path, Mark refunded included. Increment 3 adds the site's private
  `DOWNLOADS` R2 streamer.

**The platform shape.** The plugin cannot return bytes or set response headers, because EmDash
wraps every route's return in a JSON envelope. Only the site can stream from R2 (design note §2).
So the 402, the headers and the bytes belong to the site. The pricing, the facilitator calls and
the order belong to the plugin.

## Decision

### 1. What is gated: one digital product at `GET /x402/products/{slug}`

- **The resource** is a site route, `/x402/products/{slug}`. Without a payment it answers 402.
  With a valid payment it streams the product's file through the downloads streamer (#376 part 1,
  increment 3). The same four-check `entitlements/download` gate is re-run before any bytes go
  out.
- **Only digital products are gateable**, and in v1 only when all of these hold. Otherwise the
  gate answers **404**, which is also the answer for an unknown slug, so the gate does not reveal
  which products exist:
  - x402 is configured: a facilitator URL, a valid `payTo`, and at least one network from the
    asset table in Decision 3;
  - the product is `digital` and has a valid `downloadAsset`;
  - it has **exactly one active variant**, priced in **USD**;
  - the priced total is above zero.

  More than one variant would need a `?sku=` the URL cannot express yet. Adding one later is a
  backwards-compatible change. A free download is not a payment, so it uses the ordinary checkout.
- **The price is the price checkout would charge**: the domain quote for a one-line, digital-only
  order with no address and no coupon. This is `computeQuote`, the function checkout uses, under
  ADR-0021 Decision 5: a digital-only cart ignores the address
  (`packages/domain/src/pricing/quote.ts:84-95`). It includes a sale price and any tax the store's
  rules apply with no destination. There is one pricing function, so the 402 amount, the order
  total and the settled amount are all the same number. **If a tax rule would need the buyer's
  location for a digital good** (the pending tax engine, ADR-0027 on its branch), the product is
  not gateable. We answer 404 rather than guess a jurisdiction.
- **Rejected: gating an arbitrary CMS entry or field.** It has no price, tax or entitlement model.
  "A CMS entry references a digital product" can come later. The gate stays the same; only what
  is served on success changes.
- **Rejected: gating through cart checkout** (lifting #282's pin). A wallet-paid cart needs
  addresses, mixed carts and stock holds, and none of that is needed to sell one file to an agent.
  Checkout stays Stripe-only (Decision 8).

### 2. The request flow

Three surfaces, one per tier.

**The site** owns `/x402/products/[slug]`: the HTTP status, the headers and the bytes.

**The plugin** adds two public routes:
- **`x402/requirements {productSlug}`** returns the `PaymentRequired` object or `NOT_GATEABLE`.
- **`x402/pay {productSlug, paymentHeader}`** returns `{orderId, settlement}` or a typed refusal.

**The facilitator** is reached only by the plugin, only over `ctx.http.fetch`.

**A. No `PAYMENT-SIGNATURE` header.** The site calls `x402/requirements` and answers
**402 Payment Required** with:
- a `PAYMENT-REQUIRED` header carrying the base64 `PaymentRequired` (HTTP v2). The same object is
  also sent as the JSON body, because HTTP v2 leaves the body to the server
  ("Response Body"). When the request's `Accept` prefers `text/html`, the body is instead a
  short human page saying what is for sale, for how much and how to pay;
- `Cache-Control: private, no-store`.

**No order is created, and nothing is written.** The plan's "mint an order on the first 402" is
rejected: it would let any anonymous GET add an order to storage.

**B. With a `PAYMENT-SIGNATURE` header.** The site calls `x402/pay` and passes the header through
unchanged. The plugin then works through these steps, cheapest first. Steps 1–4 write nothing
and make no network call.

1. **Decode strictly.** The header must be at most 8 KiB of base64 that decodes to JSON with the
   v2 `PaymentPayload` shape (v2 §5.2.2). That means `x402Version === 2`, `accepted`, and
   `payload.signature` plus `payload.authorization` with all six fields as decimal or hex strings
   of bounded length. Anything else is `MALFORMED`, and the site answers **400**
   (HTTP v2, "Error Handling": Invalid Payment → 400).
2. **Build our requirements.** We build them from our own settings and our own price
   (Decisions 1, 3 and 4), never from the payload.
3. **Check the payment against our requirements locally**, with every comparison exact.
   The requirement side:
   - `accepted.scheme === "exact"`;
   - `accepted.network` is a configured network;
   - `accepted.asset` equals that network's USDC address (hex compared case-insensitively);
   - `accepted.payTo` equals our `payTo`.

   The authorization side:
   - `authorization.to` equals our `payTo`;
   - `authorization.value` passes the amount rule in Decision 3;
   - `validAfter ≤ now`;
   - `now + 6 s < validBefore ≤ now + maxTimeoutSeconds + 30 s`.

   A mismatch is `PAYMENT_MISMATCH`, which tells the client to pay again: the site answers **402**
   with fresh requirements and an `error` naming the field. **No facilitator call is made.**
4. **Look the payment up.** The payment key is
   `eip3009:{chainId}:{asset}:{from}:{nonce}`, lowercased. It names exactly one authorization,
   because the token contract tracks nonce use per authorizer (v2 §10.1). From it we derive the
   order's idempotency key and read with `getByIdempotencyKey`.
   - **Found, and it is for this product.** Go to the replay rules in Decision 5. Do not
     re-check the price against today's price: the order's snapshot is the contract.
   - **Found, but for another product.** Refuse with `PAYMENT_ALREADY_USED`, and the site answers
     **409**. One authorization pays for one order, which is one product.
   - **Not found.** Continue.
5. **`POST {facilitator}/verify`** with `{x402Version: 2, paymentPayload, paymentRequirements}`.
   `paymentRequirements` is **our** object from step 2, never `paymentPayload.accepted` echoed
   back.
   - `isValid: true` (a JSON boolean, not something truthy) continues.
   - `isValid: false` is `PAYMENT_INVALID`, carrying the facilitator's `invalidReason` if it is
     one of the v2 §9 codes, and the site answers **402**.
   - "Could not ask" is `FACILITATOR_UNAVAILABLE`, and the site answers **503** with
     `Retry-After`. That covers a transport error, a timeout, 408, 429, 5xx, 401/403 (our
     credential) and a body that is not the v2 §5.4 shape. **No order exists yet**, so nothing
     needs cleaning up.
6. **Create the order** with the idempotency key from step 4. It has:
   - one digital line;
   - `paymentMethod: "x402"`;
   - `buyerRef = "x402:" + lowercase(authorization.from)`;
   - currency `USD`, totals from the step-2 quote, and the ordinary hold TTL.

   The order exists **before** money can move. If anything later in the request fails, the
   payment still has an order to land on (Decision 5).
7. **`POST {facilitator}/settle`** with the same body as `/verify`.
   - **`success: true` with a well-formed answer** is a settlement:
     - `transaction` matches `^0x[0-9a-fA-F]{64}$`;
     - `network` equals the requirement's network;
     - `payer`, if present, equals `authorization.from`;
     - `amount`, if present, equals our atomic amount.

     We build a `RawConfirmation` from the verified payload, our requirements and the settle
     response, and run **`settleOrder`**. That flips `pending → paid`, records the payment with
     the transaction hash as `providerRef`, and grants the entitlement with `source: "x402"`.
     The dedupe key is the **transaction hash**, so the existing `RECEIPT_REBOUND` binding keeps
     "one transaction settles one order" (`settle-order.ts:105-127`).
   - **`success: false`** is terminal for this attempt: the facilitator did not broadcast. The
     order stays `pending` and the expiry sweep collects it later. The site answers **402** with
     a `PAYMENT-RESPONSE` carrying the failure (HTTP v2, "Example (Failure)").
   - **"Could not ask", or a `success: true` that fails the shape checks**, is
     `SETTLEMENT_UNCONFIRMED`. The money may or may not have moved. The order stays `pending`,
     and the site answers **503** with `Retry-After`. Decision 5 says what a retry does.
8. **Return `{orderId, settlement}`.** The site then:
   - runs the `entitlements/download` gate with that `orderId`;
   - streams the file with the part 1 headers (`Content-Disposition: attachment`, `nosniff`, the
     sandbox CSP and `private, no-store`);
   - adds `PAYMENT-RESPONSE` (base64 `SettlementResponse`, v2 §5.3);
   - adds `Link: </orders/{orderId}>; rel="related"`.

   The link is the re-download URL. It is ADR-0011's `orderId` scope, so the agent can fetch the
   file again later without paying, for as long as the entitlement stays active.

**Why the order is verify → create → settle:**
- Verifying before creating keeps junk out of storage. A payload the facilitator rejects never
  becomes an order.
- Creating before settling means a settlement always has an order to land on.
- Settling before `settleOrder` means we never grant access for money that has not moved.

**Rejected: settle first, then create the order.** A crash between the two would leave money
on-chain with no record of what it bought.

**Rejected: a client-side proof posted to a settle route.** That is today's model. A standard
x402 client never produces such a proof, and the server would have to trust whoever obtained it.

### 3. Amount and asset: USD minor units to USDC atomic units, exact, no floats

- **One table, in code, for each network**, taken from the reference implementation's defaults
  (`coinbase/x402` `typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts`, `DEFAULT_STABLECOINS`):

  | network | asset (USDC) | `extra` (EIP-712 domain) | decimals |
  |---|---|---|---|
  | `eip155:8453` (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `{name: "USD Coin", version: "2"}` | 6 |
  | `eip155:84532` (Base Sepolia, for staging and tests) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `{name: "USDC", version: "2"}` | 6 |

  `settings:x402Accepts` picks rows from this table and defaults to Base (`x402-wiring.ts:73`).
  **A configured network that is not in the table disables x402** (404), rather than offering a
  402 nobody can pay. That is the same fail-closed rule `isPlausiblePayTo` applies to `payTo`
  (`x402-wiring.ts:160-186`). The asset address is never configurable: an operator cannot point
  the gate at a lookalike token.
- **USD only.** The order currency must be exactly `"USD"`. Any other currency is not gateable.
  We do no FX conversion, and an INR store simply does not offer x402.
- **The conversion** is `atomic = BigInt(cents) * 10_000n` (USDC has 6 decimals; a cent has 2),
  written as a base-10 string with no sign, no leading zeros and no exponent. It uses `BigInt`
  rather than `number`, because `cents * 10_000` passes 2^53 above about 9 × 10^11 cents.
- **The check in the other direction**, from a payload to cents, accepts only
  `^[1-9][0-9]{0,30}$`. The value must be divisible by `10_000n` and equal our amount exactly. We
  never round, never parse a float, and never accept a "close enough" value.
- **Rejected: pricing in USDC separately** from the store price. That gives two prices, one of
  which can drift. Also rejected: a decimal-string or float conversion. The project's money rule
  is integer minor units.

### 4. `payTo` comes from settings, so #282's recipient gap closes by construction

The requirements we send to `/verify` and `/settle` are ours, built from `settings:x402PayTo`. The
EIP-3009 signature fixes `to` and `value` (exact-EVM, Summary), and the facilitator must check them
against our requirements (v2 §6.1.2, step 5; error `invalid_exact_evm_payload_recipient_mismatch`).
So a settlement that `/settle` reports as successful paid **our** wallet, the exact amount. The
step 3 checks also refuse a payload whose `accepted.payTo` or `authorization.to` is not ours
before any facilitator call. #282 item 1 needed a facilitator that "attests the recipient". That
is no longer needed, because the recipient is an input we supply, not a claim we receive.

`payTo` stays readable kv, for the reasons recorded at `x402-wiring.ts:36-52`.

### 5. Replay, double spend and outages

- **One authorization creates at most one order.** The order idempotency key comes from the
  payment key, so the same `PAYMENT-SIGNATURE` sent twice reaches the same order.
- **One transaction settles at most one order.** The dedupe key is the transaction hash, and
  `RECEIPT_REBOUND` refuses it on any other order.
- **One authorization moves money at most once.** The token contract will not run a used nonce
  again (v2 §10.1). So **re-sending `/settle` for a pending order can never charge twice**. This
  is what makes retrying a pending order safe.
- **Replaying a payload** we already hold an order for (step 4, same product):
  - **The order is paid and the gate passes:** we serve the file again, with **no facilitator
    call**. The `PAYMENT-RESPONSE` is rebuilt from the recorded payment. A captured header is
    therefore exactly as powerful as the order link the response already gave out, and no more.
  - **The order is paid, but the gate refuses** (a refund revoked it): the site answers **402**
    with fresh requirements and `error: "payment_already_used"`. The agent can buy again with a
    new authorization.
  - **The order is pending** (a crash, or a `SETTLEMENT_UNCONFIRMED`): we run `/verify` again.
    - If the authorization is still valid, it never ran on-chain, so we run `/settle` again,
      which is safe by the nonce rule.
    - If `/verify` now says the nonce is used or expired, the money may have moved, or the payer
      may have cancelled the authorization. We cannot tell which without reading the chain. The
      order is **flagged for reconciliation** (`x402 settlement unconfirmed`, naming the payer
      and nonce, never the signature), and the site answers **409** with the order link.
  - **The order is expired or cancelled:** a settlement that arrives after that takes the
    existing late-payment path. x402 cannot refund automatically, so the order is flagged for a
    manual refund (`settle-order.ts:63-74`; ADR-0022, first 2026-10-02 amendment).
- **Retryable and terminal.** These are retryable, so the site answers 503 with `Retry-After`:
  - `FACILITATOR_UNAVAILABLE` and `SETTLEMENT_UNCONFIRMED`;
  - storage `BUSY`.

  These are terminal:
  - `MALFORMED` (400);
  - `PAYMENT_MISMATCH`, `PAYMENT_INVALID` and a settle with `success: false` (402);
  - `PAYMENT_ALREADY_USED` and a flagged reconciliation (409);
  - `NOT_GATEABLE` (404).

  The adapter keeps today's rule that "could not ask" is never reported as "the answer was no"
  (`packages/payments-x402/src/index.ts:48-96`).
- **A lost `/settle` answer is flagged for a manual check** (decided by the product owner,
  2026-10-06). This is the unconfirmed settlement whose nonce is now used. It needs `/settle` to
  broadcast and then lose its answer. **v1 does not read the chain**: no Base RPC host is added to
  `allowedHosts`. The order is flagged, as above. ADR-0026 forbids marking a gateway order paid by
  hand, so the operator checks the chain themselves (payer, nonce, `payTo`). If the money arrived,
  they send it back to the payer, record a manual refund and use Mark refunded (Decision 6). A
  chain read (`authorizationState(from, nonce)` and the transaction receipt) that would close this
  automatically is a possible later increment, not part of this plan.

### 6. What a gate order is, and what "refund" means for it

- **Buyer identity.** `buyerRef = "x402:0x…"` (the payer wallet). The order has **no email
  address**, so no buyer email is sent. Increment 3 must make sure no buyer-email outbox row is
  queued for an `x402:` ref. Access is only by the `orderId` scope. A signed-in session never
  matches an `x402:` ref, because session refs are emails, and an `x402:` ref has no `@`
  (ADR-0011's folding caveat for non-email refs is unchanged and not reached). Signing in with a
  wallet (SIWE, v2 §10.2) is out of scope.
- **Access is re-checked on every download.** There is no token, no cache and no expiry, which is
  the part 1 rule. The gate runs on the first stream, on every replay and on every visit to the
  order link.
- **Refund.** x402 money cannot be pulled back on-chain, and Otta holds no wallet that could send
  it (ADR-0008 Decision 3; `payments-x402` `refundable = false`, `index.ts:117-124`). For a gate
  order, "refund" means:
  1. The operator **sends USDC back to the payer's wallet from their own wallet, outside Otta**.
     The payer is on the order and the transaction is the recorded `providerRef`.
  2. They **record it as a manual refund** in Money → Refunds (ADR-0008 `kind: "manual"`).
  3. They use **Mark refunded**. ADR-0026 allows it for x402, an `outside` method
     (`packages/domain/src/orders/transition.ts:145-148`), once nothing is left to refund through
     a provider.

  Mark refunded is a full refund, so it **revokes** the entitlement. Downloads increment 1 wires
  revocation into every full-refund path, Mark refunded included. The next download, and the
  next replay of the payload, are then refused. A partial manual refund does not revoke.

### 7. The facilitator: URL, `allowedHosts`, credentials

- **URL.** The URL stays a build-time define (`X402_FACILITATOR_URL`), and its host stays the only
  x402 entry in `ALLOWED_HOSTS`. The two are resolved by the same function, so they cannot
  disagree (`manifest.ts:130-156`). **Its meaning changes** from "the verification endpoint" to
  **the facilitator's base URL**. The adapter appends `/verify` and `/settle`, as the reference
  client does (`coinbase/x402` `typescript/packages/core/src/http/httpFacilitatorClient.ts:196,220,272`).
  The increment that does this updates DEPLOYMENT.md and the changeset. **No request input ever
  reaches the URL.**
- **Which facilitator: any facilitator that takes a simple key** (decided by the product owner,
  2026-10-06). The deployer picks the facilitator; Otta names none. For staging and tests we use
  `https://x402.org/facilitator`, which needs no credential. Its `/supported` (fetched
  2026-10-05) lists `exact` on `eip155:84532` (Base Sepolia) only, so it cannot settle on Base
  mainnet. **A live Base deployment therefore needs a facilitator that supports `exact` on
  `eip155:8453` and accepts no credential or a static API key.**
- **Credentials: none, or a static bearer key.** The adapter sends either no `Authorization`
  header, or `Authorization: Bearer <key>` from the existing write-only
  `settings:x402FacilitatorApiKey` (as `index.ts:301-304` does today). It builds the headers per
  call path, the seam the reference client exposes (`createAuthHeaders(path)`,
  `httpFacilitatorClient.ts:16,215-217`), so another scheme can be added later without changing
  the flow. No credential, and no part of a payload, ever appears in an error, a log line or a
  returned reason (`index.ts:84-86`).
- **Known limitation: the Coinbase CDP facilitator is not supported in v1.** CDP does not take a
  static key. Every request needs a fresh **JWT signed with the CDP API key secret** (Ed25519 or
  ES256, bound to the method, host and path, valid for 120 s). Supporting it would mean a signing
  strategy plus a key id and secret in write-only kv. That is a possible later increment, not part
  of increment 2.
- **Bounds.** Each call has a timeout: 10 s for `/verify`, and 30 s for `/settle`, which waits for
  inclusion on-chain (`DEFAULT_FACILITATOR_TIMEOUT_MS`, `index.ts:229`). Redirects are not
  followed: a 3xx counts as unavailable. Response bodies are read up to 16 KiB.

### 8. Checkout stays Stripe-only, and a test pins it (#282 item 2)

`PAYMENT_METHOD = "stripe"` in `checkout-routes.ts:101` stays. Increment 3 adds the test #282 asks
for: it fails the day checkout can create an x402 order. Cart-based x402 is a separate future
decision. That decision would reuse this ADR's adapter, which already has the recipient guarantee
of Decision 4.

### 9. The receipt-forwarding adapter and `entitlements/x402/settle` are retired, and #283 is folded in

- **`@otta-sh/payments-x402`** (increment 2) gains:
  - a requirements builder (Decisions 1, 3 and 4);
  - the payload decoder and local checks (Decision 2, steps 1–3);
  - a spec-shaped facilitator client for `/verify` and `/settle` (Decision 7).

  It **loses**:
  - `X402Facilitator.verifyReceipt`;
  - the custom-endpoint `createHttpFacilitator`;
  - the HMAC `createTestFacilitator`, `signX402Proof` and `X402Proof.signature`.

  `refundable = false` and `cancelIntent → UNSUPPORTED` stay. Tests replace the HMAC facilitator
  with an HTTP fake (Decision 11).
- **The domain** (increment 3):
  - The `page_gate` `RawConfirmation` carries the decoded payload, our requirements and the
    settle response, in place of a forwarded proof.
  - The `x402_challenge` `ClientAction` gains `asset`, `amount` (atomic, a string) and `network`,
    or is replaced by the requirements object.
  - A new use case creates the one-line digital order idempotently.
- **The plugin** (increment 4) **deletes `entitlements/x402/settle`** and its registration,
  and adds `x402/requirements` and `x402/pay`. Nothing calls the old route
  (`x402-settle-route.ts`'s own header; #282). So deleting it breaks no caller. It also removes a
  public surface that only ever settled orders nobody could create.
- **#283's items, each in the increment that touches its code:**
  - **Increment 2:** the changeset key names (`settings:edgeToken` → `settings:otta-wh-token`;
    `settings:x402FacilitatorSecret` → `settings:x402FacilitatorApiKey`).
  - **Increment 4:** the stale `x402FacilitatorSecret` symbol, field and action names, renamed
    with their test matrix.
  - **Increment 3:** make `dedupe` return the bound order instead of a boolean, which closes the
    store-emdash read-back gap.
  - **Increment 4:** delete the orphaned legacy `settings:x402FacilitatorSecret` key on first
    read.
  - **Increment 3:** a truly concurrent cross-order replay test.

### 10. Security considerations

- **SSRF.** The only outbound host is the facilitator. It is fixed at build time, enforced by
  `allowedHosts`, and its URL is never built from request data. `payTo`, `resource.url` and every
  payload field travel only in the JSON body. Redirects are not followed. The site builds the
  `resource.url` it advertises from its own configured origin, not from the `Host` header.
- **A malicious or broken facilitator.** We parse it strictly:
  - only a JSON-boolean `isValid: true` or `success: true` counts;
  - a 2xx that is not JSON, or not the v2 §5.3/§5.4 shape, counts as unavailable, never as valid;
  - a settle answer naming a different network, payer or amount is unconfirmed, never settled.

  **What we trust the facilitator for, stated plainly:** a facilitator that lies "settled" with a
  plausible transaction hash would get a file served without payment. That is inherent to x402's
  design, where the facilitator is the party that broadcasts. It is bounded by the facilitator
  being the deployer's own allowlisted choice. Checking every settlement on-chain would remove
  that trust. It needs the same Base RPC host that v1 deliberately leaves out (Decision 5), so it
  is a possible later increment.
- **A price change between the 402 and the payment.** The authorization fixes the old amount, so
  step 3 refuses it with a fresh 402 at the new price. We never charge a stale price, and never
  ask the facilitator about one. Once an order exists, its snapshot governs (Decision 5).
- **Wrong network or asset.** A payload on a network we did not offer, or for a token other than
  that network's USDC, is refused in step 3 before any facilitator call. A settle answer on
  another network is refused in step 7.
- **Abuse of the facilitator calls.** `/verify` may be metered. Any key can sign a well-formed
  authorization even with an empty wallet, so a local signature check (`ecrecover`) would not
  stop abuse. Only the facilitator's balance check does, and that is why we do not add one.
  What we do instead:
  - the step 1–4 checks refuse everything that is not a payment to us, for our exact price,
    within the time window;
  - `x402/pay` keeps the **`X-Otta-Wh-Token` edge gate** (`packages/plugin/src/edge-token.ts`):
    the site attaches the token when it dispatches, so a direct anonymous POST to the plugin
    route is refused once the token is provisioned;
  - **per-IP rate limiting on `/x402/*` at the edge** is a deployment prerequisite, as ADR-0004
    already asks for the sign-in route.
- **Privacy.** The public plugin routes return the outcome, the `orderId` and the transaction
  only, never order contents. That is the redaction rule the retired route already followed
  (`x402-settle-route.ts:50-55`).

### 11. Test plan

Increments 2–5 must ship these tests. Each one must fail first.

- **Adapter** (`payments-x402`). A **fake facilitator** sits behind the injected `fetch`, records
  every call and counts calls per path.
  - The requirements carry our `payTo`, the table's asset and `extra`, and the exact atomic
    amount. The table is pinned for 1¢, 1 USD, a 2^53-crossing price and a refused non-USD
    currency.
  - **Bad payloads reach the facilitator zero times.** Each of these is refused with
    `/verify` and `/settle` call counts of **0**: a malformed or oversize header, v1, the wrong
    scheme, network, asset, `payTo`, `to` or amount, a value not divisible by 10^4, and an
    expired or not-yet-valid window.
  - We send our requirements, not the payload's echoed `accepted`.
  - Unavailability is classified for transport errors, timeouts, 408/429/5xx/401/403, a non-JSON
    2xx, a wrong shape, a 3xx and an oversize body. A truthy-but-not-`true` answer is refused.
  - A settle answer with a mismatched network, payer or amount counts as unconfirmed.
  - With no key configured, no `Authorization` header is sent. With a key, it is sent only as
    `Authorization: Bearer`, and no credential appears in any error.
- **Domain** (contract suites on fake, SQLite, Postgres and D1):
  - one authorization makes one order under concurrency;
  - the same transaction on another order is `RECEIPT_REBOUND`, concurrently too (#283);
  - settle grants `source: "x402"`;
  - Mark refunded on a gate order revokes;
  - no buyer-email row is queued for an `x402:` ref;
  - the `PAYMENT_METHOD === "stripe"` pin (#282).
- **Plugin** (in-process and in the workerd sandbox):
  - No header → `PaymentRequired`, with **the number of stored orders unchanged**.
  - A valid payload → a paid order and an active entitlement, with `/verify` called once and
    `/settle` once.
  - **Replaying a paid payload → the same order, with zero new facilitator calls.**
  - Replaying at another product → `PAYMENT_ALREADY_USED`.
  - Verify unavailable → 503 and **no order**.
  - Settle unavailable → a pending order. A retry then verifies and settles once. A retry after
    a now-used nonce → flagged, 409.
  - A price change → a fresh 402, with zero facilitator calls.
  - Not configured, or not gateable → `NOT_GATEABLE`.
  - The edge token is enforced when it is set.
- **Site** (vitest, with a fake plugin dispatcher and a fake R2):
  - the 402 status, the base64 `PAYMENT-REQUIRED` header and the JSON body;
  - the HTML page for `text/html`;
  - on success: the bytes, `PAYMENT-RESPONSE`, `Link` and the download headers;
  - 400, 402, 409 and 503 as mapped above;
  - 404 for an unknown or ungateable slug, with no difference between the two.
- **End-to-end** (manual, then Playwright where a testnet wallet is available): pay on Base Sepolia
  through `x402.org/facilitator` with a reference x402 client, and check that the bytes' sha256
  matches. Then Mark refunded, and check that the order link and the payload replay are refused.

## Consequences

**Easier:**
- A standard x402 client (an agent with a wallet) can buy a digital product with no account, no
  cart and no email, and can download it again through the order link.
- #282's recipient gap closes with no new attestation. The money's destination is an input we
  supply.
- The adapter shrinks to the spec, and the HMAC test path and a custom endpoint no facilitator
  implements both go away.

**Harder, accepted:**
- The site holds a gate request open across two facilitator calls, one of which waits for a
  block: typically a few seconds.
- A gate order has no email, so the buyer gets no receipt email. The `PAYMENT-RESPONSE` and the
  order link are the receipt.
- Refunds are manual (Decision 6). A lost `/settle` answer with a used nonce needs a person,
  because v1 does not read the chain (Decision 5).
- The CDP facilitator, and any other facilitator that needs per-request signed credentials, cannot
  be used in v1 (Decision 7).
- We trust the facilitator's "settled" (Decision 10).
- v1 speaks **x402 v2 only**: `PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`. A
  v1 client sending `X-PAYMENT` gets the v2 402 with `error: "x402Version 1 is not supported"`,
  and no `X-PAYMENT-RESPONSE` is ever sent. The repo already uses CAIP-2 network ids, which is
  v2 style (`x402-wiring.ts:73`). Speaking both versions would double the decoder and the tests
  for clients the reference implementation has moved past. Adding v1 later would change only the
  adapter.
- Only USD stores, on Base (or Base Sepolia), with one-variant digital products, can use the gate.

**Increments this unlocks** (one PR each, design note §4):

1. **[Docs]** This ADR.
2. **[Adapters]** `payments-x402`:
   - the asset table and requirements builder;
   - the payload decoder and local checks;
   - the `/verify` and `/settle` client, with no credential or a static bearer key (no CDP JWT);
   - removal of `verifyReceipt`, the HMAC facilitator and `signature`;
   - the #283 changeset fixes.
3. **[Domain]**:
   - the new `page_gate` confirmation shape and the widened `x402_challenge`;
   - the idempotent one-line digital order use case (no buyer email);
   - `dedupe` returning the bound order;
   - the concurrent replay test;
   - the #282 pin test.
4. **[Plugin]**:
   - the public routes `x402/requirements` and `x402/pay`, behind the edge token;
   - deleting `entitlements/x402/settle`;
   - the #283 symbol renames and legacy-key cleanup;
   - Settings validation that the accepted networks are in the asset table.
5. **[Site]** `/x402/products/[slug]`:
   - the 402 with header, JSON and the human page;
   - the stream, reusing the part 1 streamer;
   - `PAYMENT-RESPONSE` and `Link`;
   - DEPLOYMENT.md: the facilitator base URL, rate limiting and the edge token.

Increments 2–4 can land before part 1's streamer. Increment 5 needs downloads increment 3.

**Possible later increments, outside this plan:**
- a CDP facilitator auth strategy (a per-request signed JWT; Decision 7);
- a chain read through a Base RPC host, which would resolve a lost `/settle` answer automatically
  (Decision 5) and could check every settlement on-chain (Decision 10).

No questions are open. Both questions in the first draft were answered by the product owner on
2026-10-06 and are recorded in Decisions 5 and 7.
