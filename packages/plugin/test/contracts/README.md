# `commerceClientContract`

The behavioural spec of the commerce client surface, expressed so **more than one transport can run
it**. Extracted from the HTTP client's own test files (INC-A7); it survives the deletion of
`HttpCommerceClient`, the four admin HTTP clients and both harnesses at the service-removal
increment — `commerce-client-contract.http.test.ts` is the tier that dies then, this directory is
not. Three slices: `storefrontCommerceClientContract` (the 25-method `CommerceClient`),
`adminOrdersProductsClientContract`, `adminRulesReportingClientContract` — one per INC-B10a/b/c.

## The tier interface

All a transport supplies: `name` (labels every `describe`), `setup()`/`teardown()` (once per
slice), `reset()`, `makeClient()`, `makeAdminClients()`, `arrange.product(spec)` (one commerce row
— sku plus optional price in integer minor units, title, on-hand), `arrange.cart(currency?)`.

- `makeAdminClients()` is **optional**. The storefront slice never asks; an admin slice handed a
  tier without it throws at collection rather than running empty.
- `reset()` may be a no-op **only while every case uses disjoint ids and no case depends on
  another's leftovers**, true today; the first real one lands at INC-B10a with the in-process tier.
- No clock/id/hold-expiry hooks: the cases pass watermarks and idempotency keys explicitly.
- **Which seeding path:** a case whose *subject* is a write method calls it directly —
  `upsertProductCommerce`, `createCart`, `addCartLine` are under test in their own cases and must
  not hide behind `arrange`. A case that merely needs a product or cart uses `tier.arrange.*`.

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

**Rejections are forward-looking.** Every failure the lifted cases assert is a typed result value,
so the contract holds no rejection assertion yet — the two that asserted a thrown error asserted an
HTTP status with it and stayed behind. The gap cases must assert an *awaited* rejection, never a
synchronous throw.
