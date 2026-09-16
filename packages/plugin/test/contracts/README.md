# `commerceClientContract`

The behavioural spec of the commerce client surface, expressed so **more than one transport can run
it**. Extracted from the HTTP client's own test files (INC-A7); it survives the deletion of
`HttpCommerceClient`, the four admin HTTP clients and both harnesses at the service-removal
increment — `commerce-client-contract.http.test.ts` is the tier that dies then, this directory is
not. Three slices: `storefrontCommerceClientContract` (the 25-method `CommerceClient`),
`adminOrdersProductsClientContract`, `adminRulesReportingClientContract` — one per INC-B10a/b/c.

## The tier interface

All a transport supplies: `name` (labels every `describe`), `setup()`/`teardown()` (once per
slice), `reset()`, `makeClient()`, `makeAdminClients()`, and `arrange` — `product(spec)` (one
commerce row: sku plus optional price in integer minor units, title, on-hand), `cart(currency?)`,
`session(email)`, `order(spec)`, `address(session, spec)`, `shippingMethod(spec)`, `coupon(spec)`,
`taxClass(spec)` (one tax-class registry entry: id + name).

- `makeAdminClients()` is **optional**. The storefront slice never asks; an admin slice handed a
  tier without it throws at collection rather than running empty (`assertAdminClients`).
- **`AdminClientSurfaces` is optional per surface, and `requireSurface` is how a slice reads one.**
  Only `products` is non-optional, because it was folded in first (INC-B10b-i); `orders` has both
  tiers too now (INC-B10b-ii) and stays typed optional deliberately, so that it is read the way
  every later surface will be; `rules` and `reporting` arrive with INC-B10c. The alternative was a
  stub — an empty `listOrders`, a zeroed `getRevenue` — and a stub makes a slice *pass* against an
  implementation that does nothing, which is worse than a missing run because it is
  indistinguishable from evidence. So a slice reads its surface through
  `requireSurface(tier, surfaces, key)`, which throws naming the tier and the surface it lacks: the
  gap lands in a test report and closes by wiring, never by softening a case. It is wired for
  `rules` and for `orders` today; `reporting` is optional but **unread**, so there is no live hole —
  the increment that first reads it must take it through `requireSurface` rather than `?.`.
- `reset()` may be a no-op **only while every case uses disjoint ids and no case depends on
  another's leftovers**. One tier does the real thing (it rebuilds cheaply); the other documents
  the no-op, which is why **every case addresses disjoint ids, skus, cart ids, coupon codes, zone
  and method ids, idempotency keys — and its own email**. A shared address would let one case's
  claimed order appear in another's list.
- **`session(email)` mints a real session through the login the transport genuinely has** — never
  by writing a session row behind the port's back. One tier issues the challenge through its
  credential verifier, because it dispatches no mail yet and the token rides in no reply; the other
  is started with a capturing mail sender and reads the challenge out of the captured message. Both
  redeem it through the **client's own** `verifyLogin`, which is the half the cases are about.
- **`order`/`address`/`shippingMethod`/`coupon`/`taxClass` seed through the `@otta-sh/domain`
  ports**, in one
  shared implementation (`test/helpers/commerce-tier-arrange.ts`) that both tiers hand their own
  adapters to. Two hand-written copies of an arrangement drift, and a case that then fails on one
  tier says nothing about the transport, because the setups were not the same.
- **Which seeding path:** a case whose *subject* is a write method calls it directly —
  `upsertProductCommerce`, `createCart`, `addCartLine`, `createOrder` are under test in their own
  cases and must not hide behind `arrange`. A case that merely needs a product, cart, session,
  order, address or rule uses `tier.arrange.*`. **A state with exactly one writer is arranged
  through that writer**, even across slices: the admin products cases reach a soft-deleted row and a
  sku under a live cart hold through the tier's own *storefront* client
  (`softDeleteProductCommerce`, `addCartLine`), because the admin surface reads both and mints
  neither, and a hand-seeded row would prove nothing about the state the refusal guards.
- **A product that will be ORDERED must be arranged with a `title`.** Order pricing snapshots the
  price *and* the title onto the line at purchase time, so an untitled row is refused
  `PRODUCT_NOT_PRICED` — the same token an unpriced row gets.

## The two optional hooks

`clock` and `payments` are optional, and each gates exactly one case that names its gate **in its
own title**, so a test report says which tier skipped what without anyone reading this file.

| Hook | What it is | Who has it | Who does not, and why |
|---|---|---|---|
| `clock.advance(ms)` | moves the one clock every store in the composition shares | the tier whose backend is rebuilt per case | a tier standing **one** long-lived backend for the whole slice: winding its clock forward expires every other case's holds, and a no-op `reset()` cannot put them back |
| `payments.method` | the method whose gateway the tier composes, i.e. a checkout can succeed | the tier that already has the payment adapters | the tier the payment adapters have **not moved to yet** — a phase gap, and when they move the hook appears and the case starts running with no edit to any case |

**Optional is not a loophole.** The two gaps are real and they point in *opposite* directions — one
tier has the gateway and not the movable clock, the other the reverse — so neither gate is a tier
quietly excusing itself. Their skip counts are equal, and every other case runs on every tier
unchanged. One case is gated on **both** and so runs on neither today; it is written anyway,
because the refusal it names (a checkout against a lapsed hold) is otherwise asserted nowhere, and
it starts running the moment either tier grows the hook it lacks.

## Classification rule

**Transport-agnostic** (→ contract) when the assertion is about the client's *method* contract:
inputs, returned values, typed result tokens, typed rejections, idempotency replay, money as
integer minor units, snapshot semantics. **HTTP-wire-specific** (→ the transport's own file) when
it asserts request shape or method, any header (gate tokens included), base-URL joining or path
encoding, status → error mapping, retry on 5xx, `allowedHosts` egress, or a stub server's recorded
requests. Never weaken an assertion to move it; a case may **split** instead — the quote cases
assert computed totals and typed reason through `quoteCheckout` here, and only the HTTP status
stays behind. The HTTP tier's stub *server* and live service stand in for the **wire**, never for a
database (real databases, never mocks) — the wire being the one thing this contract ignores.

**Rejections are awaited, and the code is asserted only where there is one.** Most failures here
are typed result values and are asserted as values. Where the port declares no typed result — a
malformed input — the failure is asserted as an **awaited** rejection, never a synchronous throw, so
an implementation that refuses before doing any work and one that cannot refuse before its round
trip behave alike under one case.

That leaves **one asymmetry, recorded rather than smoothed over**: only one transport carries a
structural code with its refusal (`INVALID_INPUT` plus the field it names). The other refuses at its
wire, and its client error carries that wire's status and body and **no code at all**. So
`expectRejectedInput` asserts that both reject, and asserts the code *where a transport supplies
one* — never a status. Asserting the code unconditionally would fail a tier over the shape of its
error rather than its behaviour; asserting the status would put the wire back into the one contract
that exists to be free of it.

**What could not be shared, and why.** Two families stayed with the in-process transport, and
neither is a case that was merely inconvenient:

- the **cart-facing bounds** (quantity, cart-id charset) — the other transport normalizes a bad
  cart value into one of the port's typed cart tokens rather than rejecting, so the same input
  produces a rejection on one tier and a resolved `{ ok: false, reason }` on the other. A shared
  case would have to assert one loosely enough to accept the other, which is exactly the softening
  that makes an equivalence proof worthless;
- the **empty variant key** — an empty key makes the other transport build a path with an empty
  segment and miss its route altogether, so a shared case would assert a route miss there and the
  bound here. The shared case uses a *whitespace* key on all three writers instead, and the empty
  one is asserted on the tier that checks the bound before any call;
- the **egress count** — the other transport's whole job is egress, so it has nothing to assert;
  "nothing reached for `ctx.http`" is only a claim one of the two can make at all;
- the **two pinned gaps** — "checkout composes no gateway, and the refusal damages nothing" and "a
  login records one challenge and dispatches no mail" — because in each the *other* transport does
  the very thing this one does not, so there is no single outcome for a shared case to assert.

**`COUPON_MAX_PER_CUSTOMER` is checkout-only and is deliberately absent from the quote cases.** The
quote path validates and never redeems, so a per-customer cap cannot surface from it; the port says
so by leaving it out of the quote's reason union and carrying it in the checkout's. It is pinned
where it belongs — in the domain's `CouponStore.redeem` result and in `CreateOrderFailure` — and the
quote cases enumerate only the four `CouponValidationFailure` reasons plus `COUPON_NOT_FOUND`.
