---
"@otta-sh/plugin": minor
---

Phase 3 (Wave 3) — the storefront cart half of `@otta-sh/plugin`.

- Adds five plugin-owned **public** storefront cart routes (workerd
  sandbox-clean, per ADR-0003) — `storefront/cart/create`, `.../cart/read`, and
  `.../cart/lines/{add,update,remove}`. Input is hand-validated (the routes are
  public), carries the caller's idempotency key, and the already-typed result is
  returned verbatim. Typed cart outcomes (`OUT_OF_STOCK`, `CART_NOT_FOUND`,
  `LINE_NOT_FOUND`, …) ride out as a `{ ok: false; reason }` value rather than a
  status code — callers branch on the token. Exercised end-to-end under the real
  workerd binary.
- Adds the `CommerceClient` cart methods (`createCart`, `getCart`, `addCartLine`,
  `adjustCartLine`, `removeCartLine`), contract-tested against the port.
- Fills the Phase 2 add-to-cart extension seam on the product view model: a
  purchasable product now carries a **Block Kit** add-to-cart affordance (a
  quantity stepper + submit button, not React), gated on the same `purchasable`
  flag as price/availability and carrying a fresh idempotency key per render;
  a non-purchasable product still renders `null`.
- Exports a `totalQty(cart)` helper and the cart wire/result types
  (`CartWire`, `CartLineWire`, `CartResult`, `CartFailureReason`) for theme use.

Two known follow-ups, out of scope here: a cart line carries no `productId` or
price, so the read route cannot join a live price total — `totalQty` is the one
honest total today. And a sandboxed route cannot emit `Set-Cookie` (the runner
serializes its return value to plain JSON) or read the inbound `Cookie` header,
so `cart/create` returns a cookie **descriptor** for a first-party theme shim to
apply on its own response rather than setting the cart cookie itself — a
documented deviation from plan §4's literal wording, a candidate follow-up ADR.
