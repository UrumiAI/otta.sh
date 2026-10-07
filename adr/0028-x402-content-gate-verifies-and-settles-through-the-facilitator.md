# 0028. The x402 content gate answers 402 itself and settles through the facilitator's `/verify` and `/settle`

- Status: accepted
- Date: 2026-10-05
- Amended: 2026-10-06. The product owner answered the draft's two open questions (Decisions 5 and
  8), and review rounds 1 and 2 reshaped the flow and the plan. The changes are listed at the end
  of this record.
- Amended: 2026-10-07. Review round 5 found that replaying a paid payment would hand the file and
  the `orderId` to anyone who can read the chain. The product owner decided that a lost response
  is **not** recovered automatically: only the request that settled the payment receives the file
  (Decision 5, "Who receives the file").
- Decided by: the product owner, 2026-10-05 (issue #376 part 2): standard x402, digital products
  only, USD stores first, USDC on Base, access re-checked on every download, and a full refund
  revokes it. On 2026-10-06 the product owner added two more decisions: live payments use any
  facilitator that takes no credential or a static API key, and a lost `/settle` answer is flagged
  for a manual check with no chain read in v1. On 2026-10-07 the product owner decided that a
  replayed payment never receives the file again, and that v1 has no lost-response recovery (no
  wallet-ownership proof).
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
  as an inline-email caller. That route is retired (Decision 10), and a gate order has no email
  recipient (Decision 7).
- Numbering: 0027 is reserved by the tax-engine branch stack (`feat/tax-engine`, `tax/1-engine`
  and later), which lands it separately.
- Spec: x402 as of `coinbase/x402@dd927a26` (2026-04-21). Citations are to
  `specs/x402-specification-v2.md` ("v2 §n"), `specs/x402-specification-v1.md` ("v1 §n"),
  `specs/transports-v2/http.md` and `specs/transports-v1/http.md` ("HTTP v2" / "HTTP v1"), and
  `specs/schemes/exact/scheme_exact_evm.md` ("exact-EVM"). Reference-implementation citations
  (`typescript/packages/…`) are to the same commit.

## Context

**Citations.** File and line citations to the repo in this Context section, and in the Decisions
where they describe code that existed before this plan, are as of `main` at `49360fe6`
(2026-10-05), the base this record was written on. Some of that code has since moved or been
deleted, for example by increment 2. Citations to the merged `X402Rail` port and the
`payments-x402` rail (`x402-rail.ts`, `rail.ts`, `facilitator.ts`) and its tests are as of `main`
at `efcf5a7a` (2026-10-07).

Issue #376 asks for an x402 content gate. An agent or a person asks for a digital product, is told
the price with an HTTP 402, pays in USDC, and gets the file in the same exchange. The design note
for #376 (§4) found that the repo has x402 pieces, but they do not fit the protocol.

**What the protocol does** (v2 §2, §5, §7; HTTP v2):

1. **The 402.** The resource server answers **402** with a `PaymentRequired` object:
   `x402Version: 2`, a `resource`, and `accepts[]`, a list of `PaymentRequirements`
   `{scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra}` (v2 §5.1.2).
   - `amount` is a string in the asset's atomic units, and `network` is CAIP-2 (v2 §11.1).
   - Over HTTP the object is sent base64-encoded in a `PAYMENT-REQUIRED` header (HTTP v2,
     "Payment Required Signaling").
   - v1 sent it as the JSON body, named the amount `maxAmountRequired`, and used network names
     such as `base` (v1 §5.1.2; HTTP v1).
2. **The payment.** The client sends the request again with a `PaymentPayload` in a
   **`PAYMENT-SIGNATURE`** header (HTTP v2, "Payment Payload Transmission"). v1 used
   **`X-PAYMENT`** (HTTP v1). The payload carries `accepted` (the requirements it chose). For
   `exact` on EVM it also carries `payload.signature` plus an EIP-3009 `authorization`
   `{from, to, value, validAfter, validBefore, nonce}` (v2 §5.2.2; exact-EVM §1, "Phase 1").
3. **Verify and settle.** The **resource server** calls the facilitator.
   - **`POST /verify`** takes `{x402Version, paymentPayload, paymentRequirements}` and answers
     `{isValid, invalidReason?, payer?}` (v2 §7.1, §5.4).
   - **`POST /settle`** takes the same body and answers
     `{success, errorReason?, payer?, transaction, network, amount?}` (v2 §7.2, §5.3).
   - The settlement goes back to the client in a **`PAYMENT-RESPONSE`** header (HTTP v2,
     "Settlement Response Delivery"). v1 named it **`X-PAYMENT-RESPONSE`** (HTTP v1).
4. **`exact` on EVM with USDC.**
   - Settlement calls `transferWithAuthorization` on the token contract (v2 §6.1.3; exact-EVM §1,
     "Phase 3").
   - The signature fixes the amount and the destination: "the Facilitator cannot modify the
     amount or destination" (exact-EVM, Summary).
   - Replay protection is the EIP-3009 nonce: the token contract refuses a nonce it has already
     used (v2 §10.1).
   - The facilitator's checks are listed in v2 §6.1.2 and exact-EVM §1 "Phase 2". Its error codes
     are in v2 §9, among them `invalid_exact_evm_payload_recipient_mismatch` and
     `invalid_exact_evm_payload_authorization_value_mismatch`.
   - exact-EVM also defines Permit2 and ERC-7710 transfer methods (exact-EVM §2, §3). USDC
     supports EIP-3009, which the scheme recommends (exact-EVM, Summary table).

**What the repo has instead:**

- **A receipt-forwarding adapter.** `@otta-sh/payments-x402` uses a receipt-forwarding model.
  - Its challenge is `{kind: "x402_challenge", accepts, price: Cents, payTo}`
    (`packages/payments-x402/src/index.ts:135-143`, `packages/domain/src/ports/payment-gateway.ts:329`).
    It names no asset and no atomic amount.
  - The "proof" is a settle response that something else obtained, plus a `signature`
    (`payment-gateway.ts:345-356`).
  - `createHttpFacilitator` posts that proof to one custom endpoint and expects `{valid: true}`
    back (`index.ts:296-364`). No standard facilitator has that endpoint.
  - The only facilitator that can produce `signature` is the offline HMAC test one
    (`index.ts:386-419`).
- **The recipient check is missing.** The adapter never checks that the money went to our
  `payTo`. Its own header says so (`index.ts:38-46`), and so does #282 item 1.
- **`entitlements/x402/settle` has no caller.**
  - The route (`packages/plugin/src/payments/x402-settle-route.ts:96`, registered public at
    `packages/plugin/src/plugin.ts:221-224`) builds a `page_gate` confirmation from client JSON
    (`x402-settle-route.ts:173-205`, `:343`).
  - It settles only an existing order whose `paymentMethod` is `"x402"` (`:336-340`).
  - Checkout never creates one, because it hardcodes `PAYMENT_METHOD = "stripe"`
    (`packages/plugin/src/storefront/checkout-routes.ts:101`, used at `:651`; #282).
- **No x402 integration exists.** The phase-4 plan assumed an `@emdash-cms/x402` Astro integration
  exposing `Astro.locals.x402`. No such package is installed, and emdash 0.38 has no x402 code
  (design note §4).

**What we can reuse:**

- **The domain's settlement path.**
  - `settleOrder` refuses a dedupe key that is already bound to a different order
    (`RECEIPT_REBOUND`, `packages/domain/src/orders/settle-order.ts:105-127`).
  - It requires the amount and currency to equal the order total (`:196-208`).
  - It grants one entitlement per digital line with `source: "x402"` (`:320-334`).
- **The configuration.**
  - The facilitator URL is a build-time define, `X402_FACILITATOR_URL`
    (`sites/staging/astro.config.ts:59`, baked at `:234`). Its host is the only x402 entry in
    `ALLOWED_HOSTS` (`packages/plugin/src/manifest.ts:97-104`, `:173`).
  - `payTo` and the accepted networks are readable kv
    (`packages/plugin/src/payments/x402-wiring.ts:64-73`). `isPlausiblePayTo` shape-checks
    `payTo` as a bare EVM address or a CAIP-10 account (`:154-186`).
  - The facilitator credential is write-only kv (`settings:x402FacilitatorApiKey`,
    `packages/plugin/src/payment-secrets.ts:83`).
- **The download work in #376 part 1** (design note §3; PRs #394 and #396, and the
  `feat/downloads-3-site-endpoint` branch).
  - `entitlements/download` returns the file descriptor only when four checks pass: the grant is
    active, the order is deliverable, the product is digital, and the asset is valid. Today those
    checks live only in that plugin route (#396). Decision 6 moves them into the domain.
  - A full refund revokes the grant on every path, Mark refunded included.
  - The site's `serveDownload` streams from the private `DOWNLOADS` R2 bucket after one
    `entitlements/download` dispatch (`sites/staging/src/lib/download-delivery.ts:268` on that
    branch). `downloadHref(orderId, sku)` builds its URL (`:63`).

**The platform shape.** The plugin cannot return bytes or set response headers, because EmDash
wraps every route's return in a JSON envelope. Only the site can stream from R2 (design note §2).
So the 402, the headers and the bytes belong to the site. The pricing, the facilitator calls and
the order belong to the plugin, and the decisions about money belong to the domain.

## Decision

### 1. What is gated: one digital product at `GET /x402/products/{slug}`

- **The resource** is a site route, `/x402/products/{slug}`.
  - Without a payment it answers 402.
  - With a valid payment it streams the product's file through `serveDownload` (Decision 6). The
    four-check delivery gate runs before any bytes go out: once in the domain, and again in
    `serveDownload`.
- **Only digital products are gateable**, and in v1 only when all of these hold. Otherwise the
  gate answers **404**, which is also the answer for an unknown slug, so the gate does not reveal
  which products exist:
  - x402 is configured: a facilitator URL, a `payTo` that projects onto the network (Decision 4),
    and at least one network from the asset table (Decision 3);
  - the product is `digital` and has a valid `downloadAsset`;
  - it has **exactly one active variant**, priced in **USD**;
  - the priced total is above zero.

  More than one variant would need a `?sku=` the URL cannot express yet. Adding one later is a
  backwards-compatible change. A free download is not a payment, so it uses the ordinary checkout.
- **The price is the price checkout would charge.** It is the domain quote for a one-line,
  digital-only order with no address and no coupon.
  - **The quote input is built by the same helper checkout uses.** Today checkout builds the
    `computeQuote` lines inline (`packages/plugin/src/commerce/in-process-commerce-client.ts:966-1000`).
    `createOrderFromCart` builds them again (`packages/domain/src/orders/create-order-from-cart.ts:217-300`,
    quote at `:285`). The tax-engine stack adds a `taxProfile` to `QuoteCommand`
    (`tax/1-engine`: `packages/domain/src/pricing/quote.ts:51`; checkout wiring on
    `tax/3-checkout-display`). Increment 3, a pure refactor, extracts one "quote command for these lines" helper,
    and checkout, `createOrderFromCart` and the gate all call it. Whatever the tax engine adds
    then reaches the gate with no second edit. The 402 amount, the order total and the settled
    amount are the same number.
  - **Tax on a digital good with no address.** ADR-0021 Decision 5 says a digital-only cart ignores
    the address (`packages/domain/src/pricing/quote.ts:84-95`). ADR-0027 keeps "digital goods are
    still untaxed without a zone" and leaves destination tax for services to a follow-up ADR
    (`tax/1-engine`: `adr/0027-…md:228`). So today the gate's price is the checkout price, with no
    tax on the digital line. **The 404 rule is concrete:** when that follow-up ADR makes a digital
    good's tax depend on the buyer's location, the gate must either collect a location or treat the
    product as not gateable. That follow-up ADR must say which.
- **Rejected: gating an arbitrary CMS entry or field.** It has no price, tax or entitlement model.
  "A CMS entry references a digital product" can come later. The gate stays the same; only what
  is served on success changes.
- **Rejected: gating through cart checkout** (lifting #282's pin). A wallet-paid cart needs
  addresses, mixed carts and stock holds, and none of that is needed to sell one file to an agent.
  Checkout stays Stripe-only (Decision 9).

### 2. Where the logic lives: a domain use case over a separate x402 port

**One domain use case, `payForGatedProduct`, runs the whole flow.** That covers verify, create,
settle, the delivery check (`authorizeDownload`, Decision 6) and the replay tree in Decision 5, in
`@otta-sh/domain`, with no IO. The plugin route only adapts: it reads settings, builds the stores, calls the use case and maps its typed outcome to a
wire result. The site only adapts the wire result to HTTP.

**A new port, `X402Rail`** (`packages/domain/src/ports/x402-rail.ts`), carries everything
protocol-specific. `@otta-sh/payments-x402` implements it. Its methods:

| Method | Kind | What it does |
|---|---|---|
| `offer(price: Money, resourceUrl)` | pure | Returns the `PaymentRequired` object and its per-network requirements, or `NOT_OFFERED`. |
| `decode(header)` | pure | Returns the decoded payment, or `MALFORMED`. The decoded payment exposes what the domain decides on: `paymentKey`, `network`, `payer`, the amount converted exactly back to `Cents`, `validAfter`, `validBefore`, and the opaque payload. |
| `matchOffer(decoded, offer)` | pure | Structural match: scheme, network, asset, `payTo`, `authorization.to`, `extra` and the transfer method. Never the amount or the time window: the domain checks those against the order or the clock. |
| `verify(decoded, offer)` | IO | `{valid, payer}`, `{invalid, reason}` or `{unavailable}`. |
| `settle(decoded, offer)` | IO | `{settled, transaction, network, payer}`, `{rejected, reason}` or `{unconfirmed}`. The adapter returns `rejected` only when it is proven pre-broadcast (Decision 5, step 8). |

**One rail instance, the same objects.** A request calls `offer`, `matchOffer`, `verify` and
`settle` on **one** rail instance, and passes back the exact `offer` and decoded payment that
instance returned. The merged rail refuses a copy (a spread, a rebuilt object, or an offer from
another instance) with no facilitator call: `matchOffer` answers `PAYMENT_MISMATCH` (`payload`),
and `verify` and `settle` answer `offer_mismatch` (`packages/domain/src/ports/x402-rail.ts:25-31`).
So every offer the use case builds, including the snapshot-priced offer for a retry (C), comes from
`offer()` on the same instance it then verifies and settles through.

**Rejected: new methods on `PaymentGateway`.**
- Stripe has no analogue, so every new method would need a Stripe stub. ADR-0008 already rejected
  a gateway interface that pretends a method can do something it cannot.
- These outcomes have three arms each: valid, invalid or unavailable, and settled, rejected or
  unconfirmed. `ConfirmationResult`'s failure union is closed and terminal-only. That is why the
  pre-increment-2 adapter had to throw to say "retry" (`packages/payments-x402/src/index.ts:75-82`).
- `settleOrder` keeps calling `PaymentGateway.verifyConfirmation`, unchanged. Dedupe, the amount
  check, the grant and the late-payment logic stay shared with Stripe.

**The new `page_gate` confirmation.** `RawConfirmation`'s `page_gate` arm carries a
`GatedSettlement`: `{orderId, paymentKey, transaction, network, payer, amount: Cents, currency}`.
Only `payForGatedProduct` builds it, in the same process, from `X402Rail.settle`'s `settled`
result. `X402PaymentGateway.verifyConfirmation` then does **structural normalisation only**. It
checks the fields' shapes and returns `ok` with `dedupeKey = paymentKey` and
`providerRef = transaction + "#" + paymentKey`.

**It is unforgeable at the type level.** `GatedSettlement` is an opaque branded type: a
`unique symbol` brand declared in `pay-for-gated-product.ts`. The minting function lives in that
module and is **not exported from `@otta-sh/domain`'s index**. The type is exported, so an adapter
can read the fields. Nothing outside the module can build a value without an `as` cast, and review
rejects that cast. Domain tests import the module by its path.

**One other route reaches the mint: `@otta-sh/domain/testing`.** `FakePaymentGateway.pageGate`
(`packages/domain/src/testing/fake-payment-gateway.ts:167-176`) has to mint a `GatedSettlement`,
because adapter suites drive settlement through it. For example,
`packages/store-emdash/test/order-flow.dialects.test.ts:514` uses it. So the mint is reachable
through the `./testing` export (`packages/domain/package.json`). Increment 7 adds a
**dependency-cruiser rule** (`.dependency-cruiser.cjs`) that forbids importing
`@otta-sh/domain/testing` from any non-test `src` file. That keeps the minting route out of
production code by lint, not by convention.

**This reverses today's invariant**, "facilitator-verified server-side — never trust the plugin's
word" (`index.ts:158`). The reversal is safe because of an invariant that increment 2 makes true
and every later increment keeps:

> **No client-supplied JSON ever reaches a `page_gate` confirmation, and no surface that can create
> an x402 order ships while the old route lives.**

The brand makes the first half something the compiler checks, not just a convention.

The facilitator verification has not gone away. It moved one call earlier, into `X402Rail.settle`,
and nothing outside the use case can supply its result.

**The dedupe key is the authorization, not the transaction.** A facilitator may batch many
authorizations into one transaction, so "one transaction settles one order" is not a property we
can rely on. The property is **one authorization settles at most one order**. Two keys enforce it:
- the `paymentKey` dedupe, through `RECEIPT_REBOUND`;
- the order idempotency key derived from the same `paymentKey`.

The `providerRef` keeps the transaction hash for the operator. It stays globally unique even when
one transaction carries several authorizations.

### 3. Amount and asset: USD minor units to USDC atomic units, exact, no floats

- **One table, in code, for each network**, taken from the reference implementation's defaults
  (`coinbase/x402` `typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts`, `DEFAULT_STABLECOINS`):

  | network | asset (USDC) | `extra` (EIP-712 domain) | decimals |
  |---|---|---|---|
  | `eip155:8453` (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `{name: "USD Coin", version: "2"}` | 6 |
  | `eip155:84532` (Base Sepolia, for staging and tests) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `{name: "USDC", version: "2"}` | 6 |

  - Our requirements also carry `extra.assetTransferMethod: "eip3009"`, as in exact-EVM §1's
    example.
  - `settings:x402Accepts` picks rows from this table and defaults to Base (`x402-wiring.ts:73`).
  - **A configured network that is not in the table disables x402** (404), rather than offering a
    402 nobody can pay. This is the same fail-closed rule `isPlausiblePayTo` applies to `payTo`.
  - The asset address is never configurable, so an operator cannot point the gate at a lookalike
    token.
- **USD only.** The order currency must be exactly `"USD"`. Any other currency is not gateable.
  We do no FX conversion, and an INR store simply does not offer x402.
- **The conversion** is `atomic = BigInt(cents) * 10_000n` (USDC has 6 decimals; a cent has 2).
  - It is written as a base-10 string with no sign, no leading zeros and no exponent.
  - It uses `BigInt` rather than `number`, because `cents * 10_000` passes 2^53 above about
    9 × 10^11 cents.
- **The check in the other direction**, from a payload to cents, accepts only `^[1-9][0-9]{0,30}$`.
  The value must be divisible by `10_000n` and convert to the exact `Cents` the domain compares. We
  never round, never parse a float, and never accept a "close enough" value.
- **Rejected: pricing in USDC separately** from the store price. That gives two prices, one of
  which can drift. Also rejected: a decimal-string or float conversion. The project's money rule
  is integer minor units.

### 4. `payTo` and every address: one projection, 20-byte comparison

- **Every address is compared as 20 bytes of hex, case-insensitively.** That covers `payTo`,
  `accepted.payTo`, `authorization.to`, `authorization.from` against the settle `payer`, and
  `accepted.asset` against the table. EIP-55 checksums are only letter case, so a comparison that
  is case-sensitive would refuse a correct, checksummed address.
- **The `payTo` projection.** `settings:x402PayTo` may be either shape that `isPlausiblePayTo`
  accepts (`x402-wiring.ts:154-186`).
  - **A bare `0x…` address is used as-is** on every offered network.
  - **A CAIP-10 account `eip155:<chain>:0x…` projects to its address only on the network whose
    CAIP-2 id is `eip155:<chain>`.** The chain reference is compared as an **exact string**, so
    `eip155:08453` does not match `eip155:8453`. On any other network it does not project, and that
    network is not offered. If no configured network is left, the product is not gateable.
  - **The requirements carry the bare address.** The spec's `payTo` is a wallet address
    (v2 §5.1.2).
  - **The stored setting is never rewritten.** `x402-wiring.ts:178-180` records why a fund
    destination must not be normalised in storage. The projection is computed on every read.
- **The recipient gap in #282 closes by construction.**
  - The requirements we send to `/verify` and `/settle` are ours, built from that projection.
  - The EIP-3009 signature fixes `to` and `value` (exact-EVM, Summary), and the facilitator must
    check them against our requirements (v2 §6.1.2, step 5; error
    `invalid_exact_evm_payload_recipient_mismatch`).
  - So a settlement that `/settle` reports as successful paid **our** wallet, the exact amount.
  - `matchOffer` also refuses a payload whose `accepted.payTo` or `authorization.to` is not ours,
    before any facilitator call.
  - #282 item 1 needed a facilitator that "attests the recipient". That is no longer needed,
    because the recipient is an input we supply, not a claim we receive.
- `payTo` stays readable kv, for the reasons recorded at `x402-wiring.ts:36-52`.

### 5. The request flow and the replay rules

**Three surfaces:**
- **The site** owns `/x402/products/[slug]`.
- **The plugin** owns two public routes. `x402/requirements {productSlug}` returns the
  `PaymentRequired` object or `NOT_GATEABLE`. `x402/pay {productSlug, paymentHeader}` returns the
  use case's outcome.
- **The facilitator** is reached only through `X402Rail`, only over `ctx.http.fetch`.

**A. No `PAYMENT-SIGNATURE` header.** The site calls `x402/requirements` and answers
**402 Payment Required** with:
- a `PAYMENT-REQUIRED` header carrying the base64 `PaymentRequired` (HTTP v2);
- the same object as the JSON body, because HTTP v2 leaves the body to the server ("Response
  Body"). When `Accept` prefers `text/html`, the body is instead a short human page saying what is
  for sale, for how much and how to pay;
- `Cache-Control: private, no-store`.

**No order is created, and nothing is written.** The plan's "mint an order on the first 402" is
rejected: it would let any anonymous GET add an order to storage.

A request carrying only v1's `X-PAYMENT` gets the same v2 402, with
`error: "x402Version 1 is not supported"`.

**B. With a `PAYMENT-SIGNATURE` header.** The site calls `x402/pay` and passes the header through
unchanged. `payForGatedProduct` runs these steps, cheapest first. **Steps 1–4 write nothing and
make no network call.**

1. **Decode strictly** (`X402Rail.decode`).
   - The header is at most 16 KiB of base64 that decodes to JSON with the v2 `PaymentPayload`
     shape (v2 §5.2.2), with `x402Version === 2`.
   - **The formats are pinned:**
     - `nonce` matches `^0x[0-9a-fA-F]{64}$`;
     - `from` and `to` match `^0x[0-9a-fA-F]{40}$`;
     - `validAfter` and `validBefore` are decimal digits only;
     - `value` follows Decision 3.
   - The signature is even-length hex, at least 65 bytes, at most 6 KiB. The upper bound leaves
     room for ERC-1271 smart-wallet signatures and ERC-6492 wrapped signatures, which carry
     deployment data.
   - **Only EIP-3009 is accepted.** The payload must carry an EIP-3009 `authorization`. If
     `accepted.extra.assetTransferMethod` is present, it must be `"eip3009"`. A Permit2 or
     ERC-7710 payload (exact-EVM §2, §3) is refused.
   - Anything else is `MALFORMED`, and the site answers **400** (HTTP v2, "Error Handling":
     Invalid Payment → 400).
2. **Build our offer and match the structure** (`X402Rail.offer`, `matchOffer`).
   - The offer is built from our own settings and our own price, never from the payload.
   - The match covers what is the same for every payment to us:
     - `accepted.scheme === "exact"`;
     - a configured network;
     - that network's USDC address;
     - our projected `payTo` as both `accepted.payTo` and `authorization.to`;
     - `extra.name` and `extra.version`.
   - A mismatch is `PAYMENT_MISMATCH`. The site answers **402** with fresh requirements and an
     `error` naming the field. **No facilitator call is made.**
3. **Look the payment up, before any price or time check.**
   - The `paymentKey` is `eip3009:{chainId}:{asset}:{from}:{nonce}`, lowercased. It names exactly
     one authorization, because the token contract tracks nonce use per authorizer (v2 §10.1).
   - From it we derive the order's idempotency key and read with `getByIdempotencyKey`.
   - **Nothing in that key is secret, and this step checks no signature.** Once a payment has been
     sent to `/settle`, its `from`, `nonce` and even its signature are public: USDC emits
     `AuthorizationUsed(authorizer, nonce)` and `Transfer(from, payTo, value)`, and the settle
     transaction's calldata carries the whole authorization, `v`, `r` and `s` included. Anyone
     watching our `payTo` can rebuild a `PAYMENT-SIGNATURE` header from that and our public 402.
     Checking the signature here would not help, because the signature is public too. So **a
     found order never yields the file, the `orderId` or a `Link`** (C).
   - **Found:** the replay rules (C). Every case there except a still-unbroadcast pending order of
     this product answers the same **409 `payment_already_used`**, whatever product the order is
     for. The two pending rows of C continue through step 4, with the snapshot price.
   - **Not found:** continue.
4. **Amount and window.** This runs for a new payment and for the two pending rows of C.
   - The decoded amount must equal today's quote in `Cents` exactly. For a pending order of this
     product (no settle attempt, or only `rejected_pre_broadcast` attempts; C), the payment is
     compared against the order's snapshot (`order.totals.total`) instead of today's quote. The
     window check is the same in every case.
   - The window must satisfy `validAfter ≤ now` and
     `now + 45 s < validBefore ≤ now + maxTimeoutSeconds + 30 s`. The 45 s covers the 10 s
     `/verify` and 30 s `/settle` budgets (Decision 8).
   - `maxTimeoutSeconds` is **180**.
   - A mismatch is `PAYMENT_MISMATCH` (402, fresh requirements). A price change between the 402 and
     the payment lands here, and it costs no facilitator call.
5. **`X402Rail.verify`.** Our requirements are sent, never `paymentPayload.accepted` echoed back.
   - `valid` continues.
   - `invalid` is `PAYMENT_INVALID`, carrying the v2 §9 `invalidReason` when it is one, and the
     site answers **402**.
   - `unavailable` is `FACILITATOR_UNAVAILABLE`, and the site answers **503** with `Retry-After`.
     **No order exists yet**, so nothing needs cleaning up.
6. **Create the order, then re-check that it is this product's.**
   - The order is created idempotently on the step-3 key, with:
     - one digital line;
     - `paymentMethod: "x402"`;
     - `buyerRef = "x402:" + lowercase(from)`;
     - currency `USD`, the step-4 quote, and the ordinary hold TTL.
   - **The line snapshot reuses `createOrderFromCart`'s snapshot code**
     (`create-order-from-cart.ts:217-300`), extracted into a shared helper, not copied. The order
     snapshots price and title exactly as a cart order does.
   - **Then re-check the returned order's line.** Two requests with the same payload for products
     A and B can race the idempotent create, and only one product wins. The loser finds a line
     that is not its product and answers the same 409 `payment_already_used` as any other found
     payment (C).
7. **Begin the settle attempt: a durable marker, written before `/settle`.**
   - The order carries `x402Settle: {attempts, lastOutcome}`, where `lastOutcome` is
     `in_flight`, `rejected_pre_broadcast` or `unconfirmed`.
   - One compare-and-set increments `attempts` and sets `in_flight`. It is guarded on three
     conditions:
     - the order is `pending`;
     - `attempts` still has the value this request read;
     - **the hold's remaining time exceeds the 30 s settle timeout plus a 15 s margin**, so the
       expiry sweep cannot win while `/settle` runs.
   - **Only the winner calls `/settle`, and only the winner can receive the file.** A loser
     answers the same 409 `payment_already_used` as a replay (C). It does not wait for the winner,
     and it never serves the order even once it is paid: a concurrent request carrying the same
     authorization is indistinguishable from someone who copied it from the mempool.
   - If the hold is too short on a **first** attempt, the answer is 402 with fresh requirements
     and `error: "payment_window_closed"`. The order then expires normally, because no attempt
     was made. On a retry of an order that already has an attempt, a hold that is too short is a
     non-success with a prior attempt: the order is flagged and the answer is 409 (C).
8. **`X402Rail.settle`.**
   - **`settled`** (a well-formed `success: true`; Decision 8 lists the checks) builds the
     in-process `page_gate` confirmation and runs `settleOrder`. That flips `pending → paid`,
     records the payment and grants the entitlement with `source: "x402"`.
   - **`settled`, but `settleOrder` fails** (storage `BUSY`, or it throws). The money is on-chain
     and this request is the only one that may ever be served. The use case first retries
     `settleOrder` a bounded number of times in-process, and re-reads the order before each try
     and after the last one. **If the order is paid** (an earlier try committed but its answer was
     lost), it goes on to delivery (step 9) as a fresh settle, `Link` headers included.
     **Otherwise** the order is still `pending` with `in_flight`, and the use case **flags it at
     once**: "settled on chain, not recorded", naming the transaction hash, the payer and the
     nonce. It sets `lastOutcome: unconfirmed`, so no later request settles it. The site answers
     **409** with `error: "settlement_unrecorded"` and `PAYMENT-RESPONSE` (the buyer's receipt),
     and with **no `Link` and no `Retry-After`**: the links would not work on an unpaid order, and
     a retry with the same header gets the replay 409 (C). The flag tells the operator to **check
     first whether the order is already paid** (a try may have committed after all), and only if
     it is not, to refund the payer as below. ADR-0026 forbids marking a gateway order paid by
     hand, so the operator never records this payment. If the flag write fails too, the expiry
     sweep's flag (attempts ≥ 1) is the backstop; it lacks the hash, which the operator finds
     from the payer and nonce.
   - **A facilitator's `success: false` does not prove nothing was broadcast.** The reference
     facilitator broadcasts `transferWithAuthorization` and then waits for the receipt. If the wait
     throws, its `catch` answers
     `{success: false, errorReason: "invalid_exact_evm_transaction_failed", transaction: ""}`, even
     though the transaction may still land (`coinbase/x402`
     `typescript/packages/mechanisms/evm/src/exact/facilitator/eip3009.ts:297-329`, reason mapping
     at `eip3009-utils.ts:198-215`, constant at `errors.ts:17`).
   - **The adapter splits a `success: false` in two, not the domain.** `classifySettle`
     (`packages/payments-x402/src/facilitator.ts:365`) returns `rejected` only when the
     `errorReason` is in `PRE_BROADCAST_REASONS` (the allowlist below, `facilitator.ts:61`) **and**
     `transaction` is `""`. Every other `success: false` comes back as `unconfirmed` with
     `cause: "unproven_rejection"`. That includes:
     - `invalid_exact_evm_transaction_failed`, and any other `*_transaction_failed`;
     - `unexpected_settle_error`;
     - `invalid_exact_evm_nonce_already_used`;
     - any reason not on the allowlist, including an unknown or missing one;
     - any `success: false` that names a non-empty `transaction`.

     So in the port, `rejected` already means **proven pre-broadcast**, and the domain handles
     three arms as they come:
   - **`rejected`.** First, re-read the order: if it is paid (an identical request's earlier
     attempt won), answer 409 `payment_already_used` (C); this request did not settle it.
     Otherwise, on the **first** attempt, set `lastOutcome: rejected_pre_broadcast` and answer
     **402** with a `PAYMENT-RESPONSE` carrying the failure (HTTP v2, "Example (Failure)"). On a
     **later** attempt it is a non-success with a prior attempt: flag the order and answer **409**
     (C).
   - **`unconfirmed`** (could not ask, a `success: true` that fails the checks, or an
     `unproven_rejection`): first re-read the order; if it is paid, answer 409
     `payment_already_used`. Otherwise **flag the order at once**, set `lastOutcome: unconfirmed`
     and answer **409** with `error: "settlement_unconfirmed"`. The authorization may now be on
     the chain, so no later request may settle it again or receive the file (C). The body warns
     the client that **this authorization may still settle until its `validBefore`**, so paying
     again with a new one before then may pay twice. The flag is the
     only way forward: the operator checks the chain and sends any money back (below).

   **The pre-broadcast allowlist** (`PRE_BROADCAST_REASONS`). These are the exact `errorReason`
   strings from the spec's list (v2 §9) and from the reference facilitator's constants
   (`errors.ts:8-25`). The two sets spell some of the same failures differently, so both
   spellings are listed.

   | Failure | Spec (v2 §9) | Reference (`errors.ts`) |
   |---|---|---|
   | Not enough funds | `insufficient_funds` | `invalid_exact_evm_insufficient_balance` |
   | Bad signature | `invalid_exact_evm_payload_signature` | `invalid_exact_evm_signature` |
   | Not yet valid | `invalid_exact_evm_payload_authorization_valid_after` | the same string |
   | Expired | `invalid_exact_evm_payload_authorization_valid_before` | the same string |
   | Wrong amount | `invalid_exact_evm_payload_authorization_value_mismatch` | `invalid_exact_evm_authorization_value` |
   | Wrong recipient | `invalid_exact_evm_payload_recipient_mismatch` | `invalid_exact_evm_recipient_mismatch` |
   | Wrong network | `invalid_network` | `invalid_exact_evm_network_mismatch` |
   | Wrong scheme | `invalid_scheme`, `unsupported_scheme` | `invalid_exact_evm_scheme` |
   | Bad payload or requirements | `invalid_payload`, `invalid_payment_requirements`, `invalid_x402_version` | `invalid_exact_evm_missing_eip712_domain`, `invalid_exact_evm_token_name_mismatch`, `invalid_exact_evm_token_version_mismatch`, `invalid_exact_evm_eip3009_not_supported` |

   A facilitator that uses other strings simply gets more flags, which is the safe direction.

   **Why these are safe.** In the reference facilitator, each allowlisted reason comes either from
   the re-verify that `settle` runs **before** it broadcasts (`eip3009.ts:255-266`), or from its
   `catch` (`eip3009.ts:322-329`). The `try` that `catch` closes covers both the broadcast (`:297`)
   and `waitForTransactionReceipt` (`:304`), and the `catch` maps errors through
   `parseEip3009TransferError` (`eip3009-utils.ts:198-215`). That function maps any error it does
   not recognise to `invalid_exact_evm_transaction_failed`. So the safety rests on one fact: **a
   post-broadcast error is mapped only to `*_transaction_failed`**, never to an allowlisted reason.
   A receipt-wait timeout or an RPC error after the broadcast carries none of the revert messages
   the function matches.

9. **Authorize delivery in the domain, then serve.**
   - `payForGatedProduct` runs **`authorizeDownload`** (Decision 6) for the order's line, right
     after `settleOrder` succeeds.
   - **If it refuses, the use case itself writes the flag.** The money has moved, so the answer is
     never 402 or 404. This happens when the merchant removed the file or made the product
     physical mid-request. The use case flags the order "paid but undeliverable" through the order
     store and returns `PAID_UNDELIVERABLE`. The site answers **409** with `PAYMENT-RESPONSE` and
     the `Link` headers.
   - A storage `BUSY` at this point is retried a bounded number of times in-process. If it
     persists, the answer is **503 with no `Retry-After`**, with `PAYMENT-RESPONSE`, both `Link`
     headers and `error: "delivery_busy"`. The order is paid, and this request settled it, so it
     may carry the `orderId`. The body tells the client **not to resend the payment** (that gets
     the replay 409, C) and to fetch the `rel="enclosure"` link instead, after a short wait.
   - If it authorizes, `x402/pay` returns the order id and the sku. The site then:
     - calls `serveDownload` for that line, which re-checks the gate (Decision 6);
     - adds `PAYMENT-RESPONSE` (base64 `SettlementResponse`, v2 §5.3);
     - adds the `Link` headers.
   - If that second check refuses (a race in the milliseconds between the two checks),
     `serveDownload` answers its own 404. The response still carries `PAYMENT-RESPONSE` and the
     `Link` headers, so the buyer keeps the way back once the file is restored. This race is not
     flagged: it needs the merchant to remove the file or change the product in that instant, and
     a replay of the payment no longer runs the delivery check (C).

**C. Replay rules: a payment whose order already exists.**

**Who receives the file** (decided by the product owner, 2026-10-07). A payment header is a secret
only until it is first sent to `/settle`. From then on it can be rebuilt by anyone who reads the
chain or the mempool (step 3). So:

> **Only the request whose own `/settle` call returned `settled` receives the bytes,
> `PAYMENT-RESPONSE`, the `orderId` or the `Link` headers.** Every other request carrying that
> payment, whatever product it asks for, gets the same 409.

The links from that first response are the only way to download again. **v1 has no lost-response
recovery:** a buyer whose successful response was lost has paid and holds no link. They have the
transaction, and the operator can find the order by payer and nonce and help them off-band. We
accept that rather than serve a paid order to whoever presents its public authorization.

| Order found by `paymentKey` | What happens | Facilitator calls |
|---|---|---|
| **Every case not in the two rows below:** paid, refunded, expired, cancelled or failed, for this product or another; pending for another product; pending for this product with an attempt that is `in_flight` or `unconfirmed` | **409 `payment_already_used`.** No bytes, no `orderId`, no `Link`, no `PAYMENT-RESPONSE`, and a body that is byte-identical across every case in this row, so the answer is no oracle for which product was bought or what state the order is in. Nothing is written. | None |
| This product, pending, no settle attempt (a crash between create and step 7) | Continue from step 4: window, verify, attempt, settle. The amount is checked against the order's snapshot, and the offer is built from it. Money cannot have moved, and the header has not been public, because nothing was ever sent to `/settle`. | As for a new payment |
| This product, pending, every attempt so far `rejected_pre_broadcast` | See below. Nothing was broadcast, so the header has not been public. | `/verify`, then at most one `/settle` |

**`/settle` is never called on an order that is not `pending`, nor on one whose authorization may
already have been broadcast.**

**Pending, with only pre-broadcast attempts.**
- **The offer is rebuilt from the order's snapshot amount** (`order.totals.total`), never from
  today's quote, by calling `offer()` on the same rail instance the request then verifies and
  settles through (Decision 2). The authorization signed the old amount, and a price change since
  then must not turn a retry into a mismatch.
- Call `/verify` again.
- If the authorization is still valid, begin a new attempt (step 7: compare-and-set and hold check)
  and call `/settle` again. **This cannot charge twice.** The token contract executes a nonce once
  (v2 §10.1).
- `settled` pays the order and serves this request, which is now the one that settled it.
- **Any non-success with a prior attempt means "flagged, 409", never 402.** That covers
  `/verify` invalid, `/settle` rejected and `/settle` unconfirmed. Before flagging, the request
  re-reads the order; if it is now paid, it answers 409 `payment_already_used` instead.
- `/verify` unavailable answers **503** and changes nothing.

**Rejected: proving control of the paying wallet to recover a lost response.** A request could
prove it controls `from` (a SIWX signature over a server-issued challenge, v2 §10.2) before a paid
order is served again. The product owner decided against it for v1 (2026-10-07). It would add a
challenge round-trip, a second signature format and its verification for a rare case. Adding it
later changes only the first row of the table above, for paid orders of this product, and must
keep that row's answer the same for every case that fails the proof.

**The expiry sweep flags; it does not expire.**
- **The rule lives inside the store's guarded flip, not in a pre-check.** `expireOrdersBatch`
  (`packages/domain/src/orders/expire-orders.ts:74-119`) calls `OrderStore.expireWithOrder`, and
  that compare-and-set reads `x402Settle` in the same atomic write as the `pending → expired`
  flip. A check before the call could race a settle attempt that begins between the check and the
  flip.
- **An attempted x402 order is flagged, not expired.** When `x402Settle.attempts ≥ 1`, the same
  guarded write sets the reconciliation flag ("x402 settlement unconfirmed at hold expiry", naming
  the payer and the nonce, never the signature), leaves the order `pending`, and reports "flagged"
  rather than "expired".
- **The one exception cuts noise.** The flip may expire an order whose only attempt was proven
  pre-broadcast: `attempts == 1 && lastOutcome == rejected_pre_broadcast`. Under the allowlist in
  step 8, nothing was broadcast for it.
- The port's `listExpirable` then leaves out a flagged order, the same way `excludeIntentDue`
  leaves out intent-due orders (`expire-orders.ts:48-55`). The sweep therefore does not list it on
  every tick.
- An x402 order with no attempt expires normally.

**A lost `/settle` answer is flagged for a manual check** (decided by the product owner,
2026-10-06). **v1 does not read the chain**, and no Base RPC host is added to `allowedHosts`. Every
flag above lands in the ordinary reconciliation queue, where the operator:
1. checks the chain for the payer, the nonce and `payTo`;
2. if the money arrived, sends it back to the payer from their own wallet;
3. cancels the order, with a note naming the transaction.

ADR-0026 forbids marking a gateway order paid by hand, and Otta never recorded this capture. So
there is no ledger refund to record, and the note is the audit trail. A chain read that would
resolve this automatically is a possible later increment.

**Retryable and terminal outcomes:**

| Outcome | HTTP | Kind |
|---|---|---|
| `FACILITATOR_UNAVAILABLE` (`/verify` could not be asked; nothing was sent to `/settle`) | 503 with `Retry-After` | Retryable with the same header |
| `delivery_busy`: storage `BUSY` after a recorded settle | 503, **no `Retry-After`**, with `PAYMENT-RESPONSE` and both `Link` headers | Terminal for the header; download through the `rel="enclosure"` link |
| `MALFORMED` | 400 | Terminal |
| `PAYMENT_MISMATCH`, `PAYMENT_INVALID`, a first-attempt `rejected` (proven pre-broadcast by the adapter), `payment_window_closed` | 402 | Terminal |
| `PAYMENT_ALREADY_USED` (`payment_already_used`: any found payment except a still-unbroadcast pending order of this product, with nothing else in the answer), `SETTLEMENT_UNCONFIRMED` (`settlement_unconfirmed`, flagged, including a transport timeout on `/settle`), `settlement_unrecorded` (flagged, with `PAYMENT-RESPONSE`, no `Link`), a flagged non-success after a prior attempt, `PAID_UNDELIVERABLE` | 409 | Terminal |
| `NOT_GATEABLE` | 404 | Terminal |

**Every gate response carries `Cache-Control: private, no-store`**: the 402, the 400, the 404, the
409s, the 503s and the file. No shared cache may keep a payment answer, a `Link` or the bytes.

The adapter keeps the rule that "could not ask" is never reported as "the answer was no": the
rail never throws, and an unanswered call is `unavailable` or `unconfirmed`
(`packages/domain/src/ports/x402-rail.ts:20-23`).

**Why verify → create → mark → settle:**
- Verifying before creating keeps junk out of storage. A payload the facilitator rejects never
  becomes an order.
- Creating before settling means money that moves always has an order to land on.
- The marker means a crash or a lost answer can never let an order expire silently while its money
  may be on-chain.
- Settling before `settleOrder` means we never grant access for money that has not moved.

**Rejected: settle first, then create the order.** A crash between the two would leave money
on-chain with no record of what it bought.

**Rejected: a client-side proof posted to a settle route.** That is today's model. A standard
x402 client never produces such a proof, and the server would have to trust whoever obtained it.

### 6. Delivery: a domain `authorizeDownload`, `serveDownload`, and the `Link` headers

- **The four-check delivery gate moves into a domain use case, `authorizeDownload`** (increment
  5). It checks four things for `{orderId, sku}` against the ports:
  - the grant is active;
  - the order is deliverable;
  - the product is digital now;
  - the stored `downloadAsset` is valid.

  It returns the asset or a refusal. The plugin route `entitlements/download` becomes a thin
  adapter over it, with the same wire behaviour as #396.
- **Why the gate has to be in the domain.** Something must be able to write "paid but
  undeliverable" when the gate refuses right after a settle (Decision 5, step 9). Today the gate
  lives only in the plugin route. The site's `serveDownload` can only answer 404 and cannot write
  to the order, and by then `x402/pay` has already returned. With the gate in the domain:
  - `payForGatedProduct` runs it after every fresh settle, and flags and answers 409 itself. A
    replay never reaches it (Decision 5, C);
  - the rule is testable against ports alone.
- **The site still streams through `serveDownload`, unchanged.** The site passes it a
  `DownloadRequest` whose URL is `downloadHref(orderId, sku)`, resolved against the request's own
  origin. `serveDownload` dispatches `entitlements/download`, which is the same domain check again.
  It sends the same headers as every download:
  - `Content-Disposition: attachment` with a sanitised filename;
  - `nosniff`;
  - the sandbox CSP;
  - `private, no-store`;
  - `Range` support.

  A gate request therefore runs the check twice, once in `x402/pay` and once in `serveDownload`.
  We accept that: each run is a few storage reads, and the second keeps `serveDownload` the single
  streaming path for every download.
- **Two `Link` headers go out only in the response to the request that settled the payment**
  (Decision 5, C), never on a replay:
  - `Link: <{downloadHref(orderId, sku)}>; rel="enclosure"` is the direct re-download URL;
  - `Link: </orders/{orderId}>; rel="related"` is the order page.

  Both use ADR-0011's `orderId` scope, which makes the `orderId` a bearer capability. That is why
  only the settling request may see it. The agent can fetch the file again through these links,
  without paying, for as long as the entitlement stays active.

### 7. What a gate order is, its email, and what "refund" means for it

- **Buyer identity.** `buyerRef = "x402:0x…"` (the payer wallet). Access is by the `orderId` scope
  only.
  - A signed-in session never matches an `x402:` ref, because session refs are emails and an
    `x402:` ref has no `@`. ADR-0011's folding caveat for non-email refs is unchanged and not
    reached.
  - Signing in with a wallet (SIWE, v2 §10.2) is out of scope.
- **No email is ever sent for a gate order, decided in one place.** Every outbox row, state email
  or notice, is sent by one drain body. That drain resolves the recipient in one function,
  `resolveRecipient` (`packages/domain/src/orders/transition.ts:602-610`, called at `:532`).
  - Today it brands a guest order's `buyerRef` as an `Email` without checking it, so it would
    "send" to `x402:0x…`.
  - Increment 4 turns it into **"the order's email recipient, or none"**. A `buyerRef` that is not
    an email address yields none, and the row is completed as "skipped". The row stores only its
    status and a `skippedAt` time, with no reason field; today "no recipient" is the only cause.
    That is not an attempt and not a failure.
  - This covers every notice that can fire for an x402 order, **ten templates** in all
    (`EmailTemplate`, `packages/domain/src/ports/email-sender.ts:10-27`):
    - `order-confirmation` (paid);
    - `order-processing`, `order-shipped`, `order-delivered` and `order-completed`. An operator can
      move a paid digital order on through any of these, because `adminNextStates`
      (`transition.ts:224-234`) does not block shipping states for digital orders;
    - `order-cancelled` and `order-expired`;
    - `order-refunded`, sent by the ledger refund path when a recorded refund reaches the ceiling
      (ADR-0026). It is not sent by Mark refunded: `transitionOrderAsAdmin` enqueues no email for
      `→ refunded` (`transition.ts:307`);
    - `order-refund-issued` (ADR-0026's notice for a partial or announced refund);
    - `order-late-payment-refunded` (ADR-0022). This is unreachable for x402, which cannot refund,
      but it is covered anyway.
  - There is one test per template.
- **Access is re-checked on every download.** There is no token, no cache and no expiry, which is
  the part 1 rule. The gate runs on the first stream and on every use of either link. A replayed
  payment never reaches it.
- **Refund.** x402 money cannot be pulled back on-chain, and Otta holds no wallet that could send
  it (ADR-0008 Decision 3; `payments-x402` `refundable = false`, `index.ts:57-61`). For a paid
  gate order, "refund" means:
  1. The operator **sends USDC back to the payer's wallet from their own wallet, outside Otta**.
     The payer and the transaction are on the order's payment.
  2. They **record it as a manual refund** in Money → Refunds (ADR-0008 `kind: "manual"`).
  3. They use **Mark refunded**. ADR-0026 allows it for x402, an `outside` method
     (`transition.ts:145-148`), once nothing is left to refund through a provider.

  Mark refunded is a full refund, so it **revokes** the entitlement (downloads increment 1, #394).
  The next download through either link is then refused. A replay of the payload was already
  refused before the refund (Decision 5, C). A partial manual refund
  does not revoke.

### 8. The facilitator: URL, `allowedHosts`, credentials, answers

- **URL.** The URL stays a build-time define (`X402_FACILITATOR_URL`), and its host stays the only
  x402 entry in `ALLOWED_HOSTS`. The two are resolved by the same function, so they cannot disagree
  (`manifest.ts:130-156`).
  - **Its meaning changes** from "the verification endpoint" to **the facilitator's base URL**.
    The adapter appends `/verify` and `/settle`, as the reference client does (`coinbase/x402`
    `typescript/packages/core/src/http/httpFacilitatorClient.ts:196,220,272`).
  - The increment that does this updates DEPLOYMENT.md and the changeset.
  - **No request input ever reaches the URL.**
- **Which facilitator: any facilitator that takes a simple key** (decided by the product owner,
  2026-10-06). The deployer picks the facilitator; Otta names none.
  - For staging and tests we use `https://x402.org/facilitator`, which needs no credential.
  - Its `/supported` (fetched 2026-10-05) lists `exact` on `eip155:84532` (Base Sepolia) only, so
    it cannot settle on Base mainnet.
  - **A live Base deployment therefore needs a facilitator that supports `exact` on `eip155:8453`
    and accepts no credential or a static API key.**
- **Credentials: none, or a static bearer key.**
  - The adapter sends either no `Authorization` header, or `Authorization: Bearer <key>` from the
    existing write-only `settings:x402FacilitatorApiKey` (`headersFor`,
    `packages/payments-x402/src/rail.ts:159-166`).
  - It builds the headers per call path, the seam the reference client exposes
    (`createAuthHeaders(path)`, `httpFacilitatorClient.ts:16,215-217`). Another scheme can then be
    added later without changing the flow.
  - No credential, and no part of a payload, ever appears in an error, a log line or a returned
    reason (`passableReason`, `packages/payments-x402/src/facilitator.ts:313`).
- **Known limitation: the Coinbase CDP facilitator is not supported in v1.**
  - CDP does not take a static key. Every request needs a fresh **JWT signed with the CDP API key
    secret** (Ed25519 or ES256, bound to the method, host and path, valid for 120 s).
  - Supporting it would mean a signing strategy plus a key id and secret in write-only kv.
  - That is a possible later increment, not part of this plan.
- **The transport seam.** `ctx.http.fetch` does not return the same object everywhere the plugin
  runs. The adapter therefore depends only on
  `{status, headers.get, url?, body?, text()}`:
  - **Trusted in-process** (EmDash 0.38's `createHttpAccess`) returns a real `Response`, with
    `url` and a streaming `body`.
  - **The Cloudflare Worker Loader sandbox** returns a plain
    `{status, ok, headers, text(), json()}`, with **no `url` and no `body`**
    (`@emdash-cms/cloudflare@0.38.0`, `dist/runner-CQpZcxVz.mjs:997-1007`). The host-side bridge,
    `sandboxHttpFetch` (`:164-209`), buffers the body as text.
- **Redirects.** In every environment the platform follows them, and the adapter cannot turn that
  off.
  - EmDash's `createHttpAccess` forces `redirect: "manual"` and then follows up to five redirects
    (`MAX_PLUGIN_REDIRECTS`). It re-checks each hop against `allowedHosts` and strips credential
    headers when the origin changes (emdash `dist/context-C9PB8vGd.mjs:1038`, `:1075-1096`).
  - The Worker Loader bridge does the same, hop by hop, inside `sandboxHttpFetch`
    (`runner-CQpZcxVz.mjs:164-209`). It also blocks private and internal hosts.
  - The plugin's test sandbox does **not** mirror either. Its `createHttpAccess`
    (`packages/plugin/src/sandbox-entry.ts:57-72`) checks the first host and then calls plain
    `globalThis.fetch`, which follows redirects with no allowlist check.
  - **The adapter detects a redirect only when `url` is present, non-empty and differs from the
    URL it requested.** It treats that answer as unavailable, never as a verdict.
  - **When `url` is absent, as in the Worker Loader sandbox, the platform's per-hop `allowedHosts`
    check is the control.** That check is EmDash's `createHttpAccess` when trusted in-process, and
    the bridge in the Worker Loader. A redirect can then land only on an allowlisted host: the
    facilitator, Stripe's API or the email provider (`manifest.ts:97-104`). An answer from one of
    those is still classified strictly by shape, so it cannot pass as a verdict or a settlement.
- **Bounds.**
  - `/verify` has a 10 s timeout, and `/settle` has 30 s, because it waits for inclusion on-chain
    (`VERIFY_TIMEOUT_MS` and `SETTLE_TIMEOUT_MS`,
    `packages/payments-x402/src/facilitator.ts:29,31`).
  - **The adapter never puts a `signal` in `init`.** The Worker Loader sandbox sends `init` to
    the host over RPC (`bridge.httpFetch(url, init)`, `runner-CQpZcxVz.mjs:999`), and an
    `AbortSignal` cannot be structured-cloned. Passing one fails **every** call there with
    `DataCloneError: AbortSignal serialization is not enabled.` (measured in #409, which removed
    the signal from the Stripe adapter for the same reason). So the adapter's own timeout race
    (`Promise.race` against a timer) is the only bound on time, on every platform
    (`FacilitatorFetch`, `facilitator.ts:113-121`). A later change must not add a signal "as a best
    effort": it would break every sandboxed facilitator call.
  - **Response bodies are capped at 16 KiB.** When `body` is present, the cap applies to the
    stream. Otherwise it applies to `text()`'s UTF-8 byte length. In the Worker Loader the bridge
    has already buffered the whole body by then, so the cap bounds what the adapter parses, not
    what the host read.
- **How answers are classified.**
  - **`/verify`:**
    - A JSON body that is exactly the v2 §5.4 shape with `isValid: true` (a JSON boolean) is
      valid.
    - A well-formed `isValid: false` body is a verdict (`invalid`) on a 2xx **or any other
      status**, unless the status is 401, 403, 408, 429 or 5xx. Facilitators differ on the status
      of a rejection. The reference client also reads a non-2xx body carrying `isValid` as a
      verdict (`httpFacilitatorClient.ts:231-242`). `x402.org/facilitator` answered a bad signature
      with 200 `{isValid: false, invalidReason: "invalid_exact_evm_signature"}`, and a malformed
      payload with **500** `{isValid: false, invalidReason: "unexpected_error"}` (probed
      2026-10-06). The second is `unavailable` under this rule, because a 5xx is never a verdict.
    - Everything else is `unavailable`:
      - transport errors and timeouts;
      - 401, 403, 408, 429 and 5xx;
      - a non-2xx without a well-formed verdict;
      - a body that is not JSON or not the shape;
      - a redirected response (detected only when `url` is present);
      - an oversize body.
  - **`/settle`:**
    - `settled` needs a well-formed `success: true` with:
      - `transaction` matching `^0x[0-9a-fA-F]{64}$`;
      - `network` equal to ours;
      - `payer`, if present, equal to `from` (20-byte comparison);
      - `amount`, if present, equal to ours.
    - A well-formed `success: false`, on any status not in the unavailable set, is split **by
      the adapter** (`classifySettle`, `PRE_BROADCAST_REASONS`): `rejected` only for an
      allowlisted reason with an empty `transaction`, which counts as nothing having been
      broadcast; otherwise `unconfirmed` with `cause: "unproven_rejection"` (Decision 5, step 8).
    - Everything else is `unconfirmed`, including a `success: true` that fails a check
      (`cause: "failed_check"`).

### 9. Checkout stays Stripe-only, and a test pins it (#282 item 2)

`PAYMENT_METHOD = "stripe"` in `checkout-routes.ts:101` stays. Increment 7 adds the test #282 asks
for: it fails the day checkout can create an x402 order. Cart-based x402 is a separate future
decision. That decision would reuse this ADR's port and adapter, which already have the recipient
guarantee of Decision 4.

### 10. Retiring the old path first, and an increment order that builds

**Increment 2 deletes `entitlements/x402/settle` before anything new lands.** It has no caller, so
deleting it breaks nothing. It is also the only surface today that turns client JSON into a
`page_gate` confirmation (`x402-settle-route.ts:173-205`, `:343`), so deleting it first closes the
old public path earliest.

From increment 2 on, two invariants hold (Decision 2):
- no client-supplied JSON reaches a `page_gate` confirmation;
- no surface that can create an x402 order exists while the old route does.

Each increment typechecks on its own and does one thing.

**#283's items, in the increment that touches each one's code:**
- the changeset key names (increment 2);
- making `dedupe` return the bound order, which closes the store-emdash read-back gap
  (increment 7);
- a truly concurrent cross-order replay test (increment 7);
- the stale `x402FacilitatorSecret` symbol, field and action names, renamed with their test matrix
  (increment 8);
- deleting the orphaned legacy `settings:x402FacilitatorSecret` key on first read (increment 8).

**The plugin routes and the site route ship together, in increment 8.** A plugin route without the
site page could take money and serve no bytes. Shipping them in one PR means the first surface that
can create an x402 order arrives complete. We rejected keeping `x402/pay` registered but switched
off: a dormant money-taking route is one flag away from live, and nothing would test it end to end.

### 11. Security considerations

- **SSRF.** The only outbound host is the facilitator.
  - It is fixed at build time, and in production every redirect hop is checked against it
    (Decision 8).
  - Its URL is never built from request data. `payTo`, `resource.url` and every payload field
    travel only in the JSON body.
  - The site builds the `resource.url` it advertises from its own configured origin, not from the
    `Host` header.
- **A malicious or broken facilitator.** Answers are classified strictly (Decision 8). Nothing but
  an exact, well-formed success counts as valid or settled.
  - **What we trust the facilitator for, stated plainly:** a facilitator that lies "settled" with a
    plausible transaction hash would get a file served without payment.
  - That is inherent to x402's design, where the facilitator is the party that broadcasts. It is
    bounded by the facilitator being the deployer's own allowlisted choice.
  - Checking every settlement on-chain would remove that trust. It needs the same Base RPC host
    that v1 deliberately leaves out (Decision 5), so it is a possible later increment.
- **A price change between the 402 and the payment.** Step 4 refuses it with a fresh 402 at the new
  price. We never charge a stale price, and never ask the facilitator about one. Once an order
  exists, its snapshot governs (C).
- **Wrong network, asset or transfer method.** Each is refused in step 1 or 2 before any
  facilitator call. A settle answer on another network is `unconfirmed`, never `settled`.
- **Lost answers and races.** These are covered by Decision 5:
  - the pre-broadcast allowlist, so a `success: false` is never trusted as "nothing moved" unless
    it is provably pre-broadcast;
  - the durable attempt marker;
  - the flag-not-expire sweep;
  - the hold check before each settle;
  - the single-winner compare-and-set;
  - the re-read before any refusal, which answers 409 rather than serving when the order turns
    out paid;
  - the product re-check after create.
- **Abuse of the facilitator calls.** `/verify` may be metered. Any key can sign a well-formed
  authorization even with an empty wallet, so a local signature check (`ecrecover`) would not stop
  abuse. Only the facilitator's balance check does, and that is why we do not add one. What we do
  instead:
  - steps 1–4 refuse everything that is not a payment to us, for our exact price, within the
    window;
  - `x402/pay` keeps the **`X-Otta-Wh-Token` edge gate** (`packages/plugin/src/edge-token.ts`). The
    site attaches the token when it dispatches, so a direct anonymous POST to the plugin route is
    refused once the token is provisioned;
  - **per-IP rate limiting on `/x402/*` at the edge is mandatory before x402 is enabled on Base
    mainnet.** DEPLOYMENT.md says so in increment 8. ADR-0004 asks for the same before sign-in is
    used.
- **A replayed payment is worth nothing.** Everything in a payment header becomes public once it
  is broadcast, signature included, so a header proves nothing about who holds it. Only the
  request whose own `/settle` returned `settled` receives the file, `PAYMENT-RESPONSE`, the
  `orderId` or the `Link` headers. Every other request with that payment gets one identical 409,
  whatever product it names and whatever state the order is in (Decision 5, C). That 409 only says
  "this authorization is spent", which the chain already says.
- **Accepted risk: a mempool front-run can deny an honest buyer the file.** Someone who sees the
  facilitator's `transferWithAuthorization` before it is mined can submit the same authorization
  first. The facilitator's transaction then reverts, the adapter returns `unconfirmed`, and the
  buyer gets 409 `settlement_unconfirmed` with no file. **Nothing is stolen:** the signature fixes
  `to` and `value`, so the money still reaches our `payTo`, and the order is flagged for the
  operator to refund. The attacker gains nothing and pays the gas. Base's sequencer does not
  expose a public mempool, which makes this unlikely. We accept it rather than add a recovery path
  (C).
- **Privacy.** The public plugin routes return only the outcome, and, to the settling request
  alone, the `orderId`, the line's sku and the transaction, never other order contents. The
  retired route followed the same redaction rule (`x402-settle-route.ts:50-55`). Flags and notes name the payer and the nonce, never the
  signature.

### 12. Test plan

Each listed test must fail first. "Calls" means the fake facilitator's per-path call counts.

**Adapter** (`payments-x402`, increment 6). A **fake facilitator** sits behind the injected `fetch`,
records every call and counts calls per path.
- **The offer:**
  - it carries the projected `payTo`, the table's asset, `extra` (with
    `assetTransferMethod: "eip3009"`), `maxTimeoutSeconds: 180` and the exact atomic amount;
  - the amount is pinned for 1¢, 1 USD and a price that crosses 2^53;
  - a non-USD currency is refused;
  - CAIP-10 `payTo` projects onto the matching network only, and a mismatched chain is not
    offered;
  - the stored setting is never rewritten.
- **Bad payloads reach the facilitator zero times.** `/verify` and `/settle` calls stay at **0**
  for each of these:
  - a malformed or oversize header;
  - v1 (`X-PAYMENT`);
  - each pinned format violated (`nonce`, `from`, `to`, `validAfter`, `validBefore`);
  - a short signature;
  - Permit2, ERC-7710 or an `assetTransferMethod` other than `eip3009`;
  - the wrong scheme, network, asset, `payTo` or `to`;
  - a value not divisible by 10^4.
- **Accepted, not refused:**
  - an upper-case or checksummed address compares equal;
  - a 1.5 KiB ERC-6492 signature is accepted.
- **What gets sent:** our requirements go out, never the payload's echoed `accepted`.
- **Classification:**
  - `/verify` with a 200, and with a 400, carrying a well-formed `isValid: false` is a verdict;
  - 401, 403, 408, 429 and 5xx are unavailable even with such a body (x402.org's 500
    `unexpected_error` included);
  - a non-JSON 2xx, the wrong shape, a redirected response (`url` present and changed) and an
    oversize body are unavailable. The oversize case is tested both as a stream and as `text()`;
  - a Worker Loader-shaped response (no `url`, no `body`, `text()` only) is classified the same as
    a `Response`;
  - **the injected fetch never receives a `signal` in `init`**, on `/verify` and on `/settle`. The
    fake facilitator's bridge mode throws `DataCloneError` for any `init.signal`, as the real
    bridge does, so a call carrying one fails the test. The `/verify` assertion is merged
    (`x402-rail.verify.test.ts:46`, `x402-rail.platform.test.ts:111`). **The same assertion for
    `/settle` is still to be added.** A transport that never answers is cut off by the adapter's
    own timeout at 10 s and 30 s, and not before;
  - a truthy-but-not-`true` answer is refused;
  - a settle answer with the wrong network, payer or amount is `unconfirmed`.
- **Credentials:** with no key, no `Authorization` header is sent. With a key, it is sent only as
  `Bearer`, and no credential appears in any error.

**Domain** (`payForGatedProduct` over a scripted `X402Rail` fake; contract suites on fake, SQLite,
Postgres and D1; increments 4, 5 and 7).
- **Basics:**
  - no payment means no write;
  - a valid payment gives a paid order and one entitlement, with one `/verify` and one `/settle`.
- **Order and keys:**
  - one authorization makes one order, concurrently;
  - the same `paymentKey` on another order is `RECEIPT_REBOUND`, concurrently too (#283);
  - **the same payload for products A and B, concurrently, gives one order; the other request
    gets the replay 409 (`PAYMENT_ALREADY_USED`) with no `orderId`.**
- **Replays: a found payment yields nothing** (Decision 5, C). Each case asserts the outcome is
  `PAYMENT_ALREADY_USED` with **no `orderId`, no sku, no transaction and no settlement to send as
  `PAYMENT-RESPONSE`**, zero `/verify` and `/settle` calls, and no write.
  - **(a)** a replay of a paid order's own header, for the same product, before and after
    `validBefore`, gets the 409 and nothing else;
  - **(chain)** a header rebuilt **only from public data**: `from`, `to`, `value`, `validAfter`,
    `validBefore` and `nonce` as the `AuthorizationUsed` and `Transfer` events and the settle
    calldata expose them, and `accepted` from our public 402. It carries a **junk signature** in
    one case and the real (public) signature in another. Both get exactly the answer (a) gets;
  - **(no oracle)** the same paid payment presented for **another** product gets an answer equal,
    field for field, to (a). So do a refunded, an expired, a cancelled and a failed order, a
    pending order for another product, and a pending order of this product whose attempt is
    `in_flight` or `unconfirmed`;
  - a pending order of this product with no attempt, or with only `rejected_pre_broadcast`
    attempts, still continues to `/verify` and `/settle`, and its settling request is served.
- **The settle-attempt marker:**
  - **(b)** the marker is durable before `/settle`: a crash injected inside `settle` leaves
    `attempts = 1`, `in_flight`;
  - **(c)** `unconfirmed` flags at once, and its HTTP mapping is asserted explicitly: a
    first-attempt `/settle` transport timeout gives **409 `settlement_unconfirmed`, not 503**,
    with no `Retry-After`, and the body warns that the authorization may still settle until
    `validBefore`;
  - **(unrecorded)** `/settle` answers `settled` and `settleOrder` then fails on every bounded
    in-process try (an injected `BUSY`, and an injected throw). The order is flagged at once with
    the transaction hash, payer and nonce, `lastOutcome` is `unconfirmed`, and the answer is 409
    `settlement_unrecorded` with `PAYMENT-RESPONSE` and **no `Link` and no `Retry-After`**. A retry
    with the same header gets the replay 409 and makes no call. In a second case a try commits but
    throws: the re-read finds the order paid, and the request is served with `Link` headers, not
    `settlement_unrecorded`;
  - **(delivery busy)** after a recorded settle, `authorizeDownload` hits `BUSY` on every bounded
    in-process try: the outcome is `delivery_busy` with the `orderId` and sku, the order stays
    paid and unflagged, and no `Retry-After` is asked for. When a later try succeeds, the request
    is served as usual;
  - **(A)** a first-attempt `rejected` carrying `invalid_exact_evm_transaction_failed` is flagged
    and answered 409 `settlement_unconfirmed`, **not 402**. So are `unexpected_settle_error`,
    `invalid_exact_evm_nonce_already_used`, an unknown reason, a missing reason, and an allowlisted
    reason with a non-empty `transaction`. Each allowlisted reason in both spellings, with an empty
    `transaction`, is a 402;
  - **(d)** any non-success on an order with a prior attempt is flagged with 409, never 402. That
    covers a retry whose `/verify` is invalid and a retry whose `/settle` is rejected;
  - **(e)** the expiry sweep flags, and does not expire, a pending x402 order with an attempt. The
    decision is made inside `expireWithOrder`'s guarded flip: a settle attempt that begins
    concurrently with the flip is never lost (a race test on Postgres). Once flagged, the order is
    not listed again. An order with no attempt still expires, and so does one with
    `attempts == 1 && lastOutcome == rejected_pre_broadcast`;
  - **(g)** a re-settle is refused when the hold's remaining time is at or below the settle
    timeout plus margin;
  - **(h)** two identical concurrent requests make exactly one `/settle` call. Only the winner
    gets the `orderId`; the loser gets the replay 409, even after the order is paid. A request
    whose `/settle` is rejected after the other request paid re-reads the order and answers the
    replay 409, not the file;
  - **(no re-settle)** after a first-attempt `unconfirmed`, a retry with the same header makes no
    `/verify` and no `/settle` call and gets the replay 409;
  - **(snapshot)** a retry of a pending order, with no attempt or only pre-broadcast attempts,
    after a price change builds its offer and its amount check from `order.totals.total`, through
    `offer()` on the same rail instance it then verifies and settles with.
- **Delivery** (all against ports, with no plugin involved):
  - `authorizeDownload` refuses on each of its four checks and passes when all four hold. The
    `entitlements/download` adapter keeps #396's wire answers;
  - when `authorizeDownload` refuses after a fresh settle, `payForGatedProduct` writes the "paid
    but undeliverable" flag and returns `PAID_UNDELIVERABLE` (409), never 402 or 404;
  - a replay never runs `authorizeDownload` (it gets the replay 409 first).
- **Type level:** a test-only `as`-free attempt to build a `page_gate` confirmation outside
  `pay-for-gated-product.ts` fails to compile (a `@ts-expect-error` case).
- **Email and refunds:**
  - each of the ten `EmailTemplate`s listed in Decision 7 is completed as "skipped" for an
    `x402:` ref;
  - Mark refunded on a gate order revokes access.
- **Shared code:**
  - the shared quote helper gives the gate and checkout the same total for the same product;
  - the line snapshot is the shared helper's;
  - the `PAYMENT_METHOD === "stripe"` pin (#282).

**Plugin and site** (in-process and in the workerd sandbox; site vitest with a fake dispatcher and
a fake R2; increment 8).
- **Plugin routes:**
  - `x402/requirements` writes nothing;
  - `x402/pay` maps every outcome above. Its `payment_already_used` answer carries no `orderId`,
    sku or transaction, and is the same bytes for every replay case;
  - the edge token is enforced when it is set;
  - not configured, or not gateable, answers `NOT_GATEABLE`.
- **Site responses:**
  - the 402 status, the base64 `PAYMENT-REQUIRED` header and the JSON body;
  - the HTML page for `text/html`;
  - v1 gets the v2 402;
  - on success: the bytes through `serveDownload`, `PAYMENT-RESPONSE`, both `Link` headers and the
    download headers;
  - `PAID_UNDELIVERABLE` maps to 409 with `PAYMENT-RESPONSE` and both `Link` headers;
  - a replay maps to 409 `payment_already_used` with **no body bytes of the file, no `Link`, no
    `PAYMENT-RESPONSE`** and no `orderId` anywhere in the response;
  - **(no oracle, at the site)** the full responses for the row-1 cases of C, at least paid for
    this product, paid for another product and pending `in_flight`, are equal in status, in every
    header and in the body;
  - `delivery_busy` maps to 503 with `PAYMENT-RESPONSE` and both `Link` headers and **no
    `Retry-After`**;
  - **every** gate response, the file included, carries `Cache-Control: private, no-store`;
  - 400, 402, 409 and 503 as mapped;
  - 404 for an unknown or ungateable slug, with no difference between the two.

**End-to-end** (manual, then Playwright where a testnet wallet is available):
1. Pay on Base Sepolia through `x402.org/facilitator` with a reference x402 client.
2. Check that the bytes' sha256 matches the uploaded file.
3. Replay the same payment header: 409 `payment_already_used`, no file and no `Link`.
4. Check that both links from step 1 still download.
5. Mark refunded.
6. Check that both links are refused, and the payload replay still gets the same 409.

## Consequences

**Easier:**
- A standard x402 client (an agent with a wallet) can buy a digital product with no account, no
  cart and no email, and can download it again through a link.
- #282's recipient gap closes with no new attestation. The money's destination is an input we
  supply.
- The money rules live in one domain use case, tested against a fake port, with the adapter reduced
  to the spec.

**Harder, accepted:**
- The site holds a gate request open across two facilitator calls, one of which waits for a block:
  typically a few seconds, at most about 40 s.
- A gate order has no email, so the buyer gets no receipt email. The `PAYMENT-RESPONSE` and the
  links are the receipt.
- **More work for the operator.**
  - Refunds are manual (Decision 7).
  - Every unconfirmed or retried-and-failed settlement, and every attempted order whose hold runs
    out, lands in the reconciliation queue for a manual chain check, because v1 does not read the
    chain (Decision 5). Most such flags will turn out to be "no money moved". We accept that noise
    rather than risk expiring an order whose money is on-chain.
- **No lost-response recovery** (decided by the product owner, 2026-10-07). Only the request that
  settled a payment receives the file and the links. An agent that loses that response has paid
  and cannot get the file by sending the payment again; a settle whose answer is lost is flagged
  (409 `settlement_unconfirmed`), not retried. The operator resolves both by hand from the payer
  and nonce. A wallet-ownership proof (SIWX, v2 §10.2) could later re-open a paid order to its
  payer by changing only the first row of Decision 5's table C.
- We trust the facilitator's "settled" (Decision 11).
- The CDP facilitator, and any other facilitator that needs per-request signed credentials, cannot
  be used in v1 (Decision 8).
- **v1 speaks x402 v2 only:** `PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`. No
  `X-PAYMENT-RESPONSE` is ever sent.
  - The repo already uses CAIP-2 network ids, which is v2 style (`x402-wiring.ts:73`).
  - Speaking both versions would double the decoder and the tests, for clients the reference
    implementation has moved past.
  - Adding v1 later would change only the adapter.
- Only USD stores, on Base (or Base Sepolia), with one-variant digital products, can use the gate.

**Increments this unlocks** (one PR each; each typechecks alone). Review round 2 split the plan
from five PRs into eight.

1. **[Docs]** This ADR.
2. **[Plugin][Adapters] Retire the receipt-forwarding path.** Nothing new can create an x402 order
   yet.
   - Delete `entitlements/x402/settle`: `x402-settle-route.ts`, its registration
     (`plugin.ts:221-224`) and its tests (`packages/plugin/test/x402-settle-route.test.ts`, plus
     the `verifyReceipt` leg of `in-process-egress.sandbox.test.ts`). Update
     `x402-wiring.test.ts`, which asserts the facilitator wiring.
   - **Remove the route's public exports** (`createX402SettleHandler`, `X402_SETTLE_ROUTE`,
     `x402SettleResultToResponse` and its types, `packages/plugin/src/index.ts:278-282`), **with a
     changeset**, because they are published API.
   - Fix the comments that name the route in `settle-deadline.ts` and `edge-token.ts`.
   - Stop `x402-wiring.ts` building a facilitator (`:60`, `:97-101`).
   - Delete `verifyReceipt`, `createHttpFacilitator`, `createTestFacilitator`, `signX402Proof` and
     `X402FacilitatorUnavailableError` from `payments-x402`.
   - **Delete or rewrite every `payments-x402` test built on them:**
     - `http-facilitator.test.ts` is deleted;
     - `x402-gateway.contract.test.ts`, `x402-hardening.test.ts`, `x402-cancel-intent.test.ts` and
       `x402-refund.test.ts` are rewritten without the HMAC facilitator.
   - `X402PaymentGateway.verifyConfirmation` refuses every `page_gate` (`MALFORMED`) until
     increment 7.
   - The domain's `X402Proof` and the fake gateway's `pageGate` (`fake-payment-gateway.ts:167-176`)
     stay for now, because domain tests still mint them.
   - The #283 changeset key names.
3. **[Domain][Plugin] Pure refactor: shared quote-input and line-snapshot helpers.** No behaviour
   changes.
   - Extract one "quote command for these lines" helper from checkout
     (`in-process-commerce-client.ts:966-1000`) and from `createOrderFromCart`
     (`create-order-from-cart.ts:217-300`), plus the line-snapshot helper.
   - Both call sites use them.
   - **This conflicts with `tax/3-checkout-display`**, which edits the same checkout lines to add
     `taxProfile` (`in-process-commerce-client.ts:1009-1024` on that branch). Whichever lands
     second rebases. The helper must carry `taxProfile` once both are in.
4. **[Domain][Adapters] "The order's email recipient, or none."**
   - `resolveRecipient` (`transition.ts:602-610`) returns none for a `buyerRef` that is not an
     email address, and the drain completes such a row as "skipped".
   - **"Skipped" is its own terminal outcome, not the existing `markEmailSent`**
     (`packages/domain/src/ports/order-store.ts:585`). Recording an email that never went as
     "sent" would break ADR-0026's rule that admin writes report whether the email went. So the
     order store gains a "skipped" completion, with contract cases on every dialect. That is why
     the tag is [Domain][Adapters], not [Domain] alone.
   - One test per `EmailTemplate` (Decision 7).
   - This is on its own because it changes behaviour for every order.
5. **[Domain][Plugin] Move the delivery gate into the domain.**
   - Add `authorizeDownload`, with the four checks against the ports.
   - `entitlements/download` becomes a thin adapter over it, with #396's wire behaviour and
     contract cases unchanged.
   - **It depends on downloads #394 (revocation, `downloadAsset`) and #396 (the gate being moved)
     being merged.**
6. **[Domain][Adapters] The `X402Rail` port and its adapter.**
   - The port in `@otta-sh/domain`, as types only (Decision 2).
   - `payments-x402` implements it:
     - the asset table and the `payTo` projection;
     - the offer, the decoder and the structural match;
     - the `/verify` and `/settle` client, with no credential or a static bearer (no CDP JWT);
     - the classification rules, including the pre-broadcast allowlist.
   - No use case calls it and there is no surface, so it can land before the downloads work.
7. **[Domain][Adapters] The gate's money rules.** It depends on increments 3, 5 and 6.
   - `payForGatedProduct` with the full replay tree, calling `X402Rail` and `authorizeDownload`.
   - The branded `GatedSettlement` `page_gate` arm, replacing `X402Proof`. This includes the fake
     gateway and `X402PaymentGateway.verifyConfirmation`'s structural normalisation, so it
     typechecks.
   - The dependency-cruiser rule that bans `@otta-sh/domain/testing` from non-test `src`
     (Decision 2).
   - The `x402Settle` marker, and the flag-not-expire rule inside `expireWithOrder`'s guarded flip,
     with contract and race cases on every dialect.
   - `dedupe` returning the bound order, the concurrent replay test, and the #282 pin test.
   - The "Mark refunded on a gate order revokes access" test. It needs #394's revocation, which
     comes through increment 5.
   - No surface calls the use case yet.
8. **[Plugin][Site] The gate goes live.**
   - The public routes `x402/requirements` and `x402/pay`, behind the edge token, wired to the use
     case and the adapter.
   - `/x402/products/[slug]`: the 402 with header, JSON and the human page; the stream through
     `serveDownload`; `PAYMENT-RESPONSE` and both `Link` headers.
   - The #283 symbol renames and legacy-key cleanup.
   - Settings validation that the accepted networks are in the asset table.
   - **The plugin's test sandbox exercises the Worker Loader response shape**, unless increment 6
     already did. `sandbox-entry.ts`'s `ctx.http.fetch` should be able to return the bridge's
     `{status, ok, headers, text(), json()}`, with no `url` and no `body`, so the sandbox suites run
     the adapter against the shape production's sandbox returns.
   - **An x402 sale issues the ADR-0027 §7 tax document**, as the Stripe settle route does. The tax
     stack adds `issueTaxDocumentNow` (`packages/plugin/src/tax/issue-tax-document-now.ts` on
     `tax/4-invoices`), and `x402/pay` calls it after a fresh settle.
     - `tax/4-invoices` also wires that call into `x402-settle-route.ts`, which increment 2
       deletes. Whichever of the two lands second drops that call.
   - DEPLOYMENT.md: the facilitator base URL, the edge token, and mandatory rate limiting before
     Base mainnet.
   - **This increment takes real money.** It depends on:
     - **all of increments 2–7** (2 retirement, 3 helpers, 4 email suppression, 5 domain delivery
       gate, 6 port and adapter, 7 money rules);
     - downloads #394 and #396 being merged;
     - downloads increment 3 (`serveDownload`, `downloadHref`).

Increments 2, 3, 4 and 6 can land before the downloads work. Increment 5 waits for #394 and #396,
and increment 7 waits for 3, 5 and 6.

**Possible later increments, outside this plan:**
- a CDP facilitator auth strategy (a per-request signed JWT; Decision 8);
- a chain read through a Base RPC host. It would resolve a lost `/settle` answer automatically
  (Decision 5) and could check every settlement on-chain (Decision 11).

No questions are open.

## Amended 2026-10-06

The amendments, against the 2026-10-05 draft:

**The product owner's answers:**
- Live payments use any facilitator that takes no credential or a static bearer key. CDP's JWT is a
  known limitation (Decision 8).
- A lost `/settle` answer is flagged for a manual check, with no chain read in v1 (Decision 5).

**Review round 1:**
- The payment lookup now runs before the price and window checks.
- A durable settle-attempt marker is written before `/settle`.
- `SETTLEMENT_UNCONFIRMED` flags at once, and any non-success after a prior attempt is flagged with
  409.
- The expiry sweep flags rather than expires an attempted order.
- `/settle` is never called on a non-pending order.
- A hold check runs before each settle.
- Identical concurrent requests resolve to one `/settle`.
- The A/B product race is re-checked after create.
- One 20-byte address comparison, and a `payTo` projection for CAIP-10.
- The increment plan now deletes the old route first and builds at every step.
- The orchestration is a domain use case over a separate `X402Rail` port. The `page_gate`
  normalisation reverses the old "never trust the plugin" invariant, under a stated invariant.
- The redirect wording is corrected.
- Email suppression lives in one place, `resolveRecipient`.
- The `Link` headers point at `downloadHref` and the order page, and delivery reuses
  `serveDownload`.
- The quote and snapshot reuse checkout's helpers.
- A refusal after a successful settle is 409, never 402 or 404.
- The live increment depends on #394 and #396.
- The dedupe key is the authorization, not the transaction.
- Pinned formats, room for ERC-1271 and ERC-6492 signatures, EIP-3009 only, and
  `maxTimeoutSeconds: 180`.
- A well-formed `/verify` rejection on a non-2xx status (other than 401, 403, 408, 429 and 5xx)
  is classified as a verdict.
- Rate limiting is mandatory before Base mainnet.

**Review round 2:**
- A first-attempt `rejected` answers 402 only for an allowlist of pre-broadcast reasons, in both
  the spec's and the reference's spellings, and only with an empty `transaction`. Everything else,
  `invalid_exact_evm_transaction_failed` included, is treated as unconfirmed (Decision 5, step 8).
- The delivery gate moves into a domain `authorizeDownload`, so `payForGatedProduct` can write
  "paid but undeliverable" itself. `serveDownload` re-checks, so a gate request runs the check
  twice (Decision 6).
- The `page_gate` arm is a branded `GatedSettlement` that only its module can mint (Decision 2).
- The expiry rule lives inside `expireWithOrder`'s guarded flip, and an order whose only attempt
  was rejected pre-broadcast may still expire.
- The CAIP-10 chain reference is compared as an exact string.
- A retry of a pending order is checked against the order's snapshot amount.
- Corrected the sandbox-harness redirect claim.
- Increment 2 now also removes the route's public exports (with a changeset), fixes two comments
  and rewrites the HMAC-based tests.
- The plan is split into eight increments, with a pure-refactor PR and a separate
  `resolveRecipient` PR.

**Review round 3:**
- The port and its adapter (now increment 6) come before the money rules (now increment 7), so
  each increment typechecks on its own.
- Go-live depends on all of increments 2–7.
- The `@otta-sh/domain/testing` route to the `GatedSettlement` mint is named, and a
  dependency-cruiser rule bans it from non-test `src`.
- The allowlist's safety is stated as the reference `catch` mapping any post-broadcast error only
  to `*_transaction_failed`.
- Increment 4 adds a "skipped" store completion, so it is tagged [Domain][Adapters].

**Review round 4 (build feedback from increment 4):**
- Decision 7's list is ten templates, not eight. `order-shipped` and `order-delivered` can fire,
  because an operator may move a paid digital order on through them.
- `order-refunded` is attributed to the ledger refund path. Mark refunded enqueues no email.
- A "skipped" row stores only its status and `skippedAt`, with no reason field.
- Increment 8 issues the ADR-0027 §7 tax document for an x402 sale, as the Stripe settle route does.

**Build feedback from increment 6:**
- Decision 8 no longer claims the final-URL redirect check works the same everywhere. The
  Cloudflare Worker Loader sandbox's `ctx.http.fetch` returns no `url` and no `body`, and its
  bridge follows redirects itself with a per-hop `allowedHosts` check.
- The adapter's transport seam is `{status, headers.get, url?, body?, text()}`.
- The body cap applies to the stream, or else to `text()`'s UTF-8 byte length.
- A redirect is detected only when `url` is present and differs. Otherwise the platform's per-hop
  check is the control.
- The adapter's own timeout race bounds the time, because an `AbortSignal` may not cross the
  bridge.
- Increment 8 makes the test sandbox exercise the bridge's response shape.

## Amended 2026-10-07 (review round 5)

- **A replayed payment never receives the file.** Everything in a payment header, the signature
  included, is public once it is broadcast. So only the request whose own `/settle` returned
  `settled` receives the bytes, `PAYMENT-RESPONSE`, the `orderId` or the `Link` headers. Every
  other found payment, for this product or another and in any state but a still-unbroadcast
  pending order of this product, gets one identical 409 `payment_already_used` with nothing else
  (Decision 5, step 3 and C; Decision 6; Decision 11).
- The single-winner loser, and the re-reads in step 8 and in a retry, answer that 409 instead of
  serving a paid order.
- A first-attempt `unconfirmed` is flagged and answered 409 `settlement_unconfirmed`, not 503. A
  payment that may have been broadcast is never settled again, so a retry could not help.
- **The product owner decided there is no lost-response recovery in v1**, and no SIWX
  proof-of-wallet challenge. This is recorded as a rejected alternative in Decision 5, C.
- The test plan inverts replay test (a), adds a header rebuilt from chain data with a junk
  signature, and requires the answer for another product, and for every other found state, to
  equal it.
- Decision 8 states the merged behaviour: the adapter never passes an `AbortSignal`, because it
  fails every call over the Worker Loader bridge with `DataCloneError` (#409). The test asserts the
  injected fetch receives no `signal`.
- Decision 5 step 8 and Decision 8 say that the adapter, not the domain, splits a `success: false`
  (`PRE_BROADCAST_REASONS`), and that an unproven one comes back as `unconfirmed` /
  `unproven_rejection`.
- Decision 2 states that every offer, the snapshot-priced retry offer included, comes from
  `offer()` on the same rail instance, because the rail refuses copies (`offer_mismatch`,
  `PAYMENT_MISMATCH`).
- Stale names fixed: `offer(price: Money, resourceUrl)`, `VERIFY_TIMEOUT_MS` /
  `SETTLE_TIMEOUT_MS`, and the bearer header now cited at `rail.ts`, not the deleted
  `index.ts:301-304`.

**Review round 5, polish (both reviewers approved; follow-ups):**
- `/settle` answering `settled` and `settleOrder` then failing is specified: a bounded in-process
  retry that re-reads the order and delivers if it is paid; otherwise a flag at once with the
  transaction hash that tells the operator to check for a paid order before refunding, and 409
  `settlement_unrecorded` with no `Link` and no `Retry-After`. Tests cover both (Decision 5, step
  8), and the bounded retry that ends in `delivery_busy`.
- A storage `BUSY` after a recorded settle is retried in-process, then answers 503 `delivery_busy`
  with no `Retry-After`, telling the client to use the link, not to resend the payment.
- The `settlement_unconfirmed` body warns that the authorization may still settle until
  `validBefore`. Test (c) asserts a `/settle` timeout maps to 409, not 503.
- A mempool front-run of the authorization is recorded as an accepted risk (Decision 11).
- A site-level test compares status, headers and body across the replay cases, and every gate
  response carries `Cache-Control: private, no-store`.
- The no-signal test is merged for `/verify` only; the `/settle` assertion is listed as still to
  add.
- Step 3 and step 4 now agree that both pending rows of C run the window check and use the snapshot
  price.
- The Context names the commits its citations refer to.
