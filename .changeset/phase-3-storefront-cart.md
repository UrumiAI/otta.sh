---
"@otta-sh/plugin": minor
---

Phase 3 (Wave 3) — storefront cart: the `@otta-sh/plugin` half the service-side
Phase 3 changeset deferred.

- Adds five plugin-owned **public** storefront cart routes (workerd
  sandbox-clean, per ADR-0003) — `storefront/cart/create`, `.../cart/read`, and
  `.../cart/lines/{add,update,remove}` — each a pure proxy over `ctx.http` to
  `@otta-sh/service`'s `/carts` REST surface. The plugin holds no cart or stock
  state: input is hand-validated (the routes are public), forwarded with the
  caller's `Idempotency-Key`, and the already-typed result is returned verbatim.
  Typed cart outcomes (`OUT_OF_STOCK`, `CART_NOT_FOUND`, `LINE_NOT_FOUND`, …)
  ride through as a `{ ok: false; reason }` value regardless of the underlying
  HTTP status — callers branch on the token, never the status code. Exercised
  end-to-end under the real workerd binary against a stub service.
- Adds `HttpCommerceClient` cart methods (`createCart`, `getCart`, `addCartLine`,
  `adjustCartLine`, `removeCartLine`) — 1:1 mirrors of `routes/carts.ts`,
  wire-tested against a live Postgres-backed `@otta-sh/service`.
- Fills the Phase 2 add-to-cart extension seam on the product view model: a
  purchasable product now carries a **Block Kit** add-to-cart affordance (a
  quantity stepper + submit button, not React), gated on the same `purchasable`
  flag as price/availability and carrying a fresh idempotency key per render;
  a non-purchasable product still renders `null`.
- Exports a `totalQty(cart)` helper and the cart wire/result types
  (`CartWire`, `CartLineWire`, `CartResult`, `CartFailureReason`) for theme use.

Known follow-ups flagged for a small `[Service]` change, out of scope here
(plugin package only): cart lines carry no `productId`/price on the wire, so the
read route cannot join a live price total — `totalQty` is the one honest total
today. And a sandboxed route cannot emit `Set-Cookie` (the runner serializes its
return value to plain JSON) or read the inbound `Cookie` header, so `cart/create`
returns a cookie **descriptor** for a first-party theme shim to apply on its own
response rather than setting the cart cookie itself — a documented deviation from
plan §4's literal wording, a candidate follow-up ADR.
