---
"@urumi/domain": minor
"@urumi/payments-stripe": minor
---

Send Stripe a PaymentIntent `description` (and `shipping`) — **fixes a blocking
payment bug**: no card payment could complete at all against an India-based Stripe
account.

Found 2026-07-27 driving a real Stripe test card through the storefront checkout on
staging: the card form filled and the brand was detected, but Stripe's Payment
Element refused to complete, rendering *"As per Indian regulations, export
transactions require a description"*
(<https://docs.stripe.com/india-exports>). `StripePaymentGateway.createIntent` sent
only `amount`, `currency`, `metadata[order_id]` and
`automatic_payment_methods[enabled]`. No unit or contract test could have caught
this — it depends on the Stripe **account's country**, not on our code shape.

- **Domain (`[Domain]`) — ⚠️ the `PaymentGateway` port widened.**
  `CreateIntentInput` gains `lines: readonly CreateIntentLine[]` (**required**) and
  `shipTo?: CreateIntentShipTo` (optional). The domain passes **structured** data —
  `{ title, quantity }` per line, plus the postal fields of the order's frozen
  ship-to — and **never** a pre-rendered provider string: what was bought is domain
  knowledge, how Stripe wants it expressed is adapter knowledge.
  - **For external implementers:** this is *source-compatible for anyone
    IMPLEMENTING `PaymentGateway`* — an implementer only consumes the input, so
    `createIntent` keeps compiling untouched (verified: `payments-x402`, the
    `FakePaymentGateway`, and the Postgres race-test gateways needed no change, and
    `paymentGatewayContract` is unmodified). It **is** a breaking change for code
    that **constructs** a `CreateIntentInput` — add `lines`. `lines` is required on
    purpose: this bug was invisible to the type system, and a required field makes
    the compiler, not a live QA session, catch the next call site that forgets.
  - `lines` carries **no money** — prices would drag the repo's hundredths-scale
    minor units into a free-text field with no currency exponent attached.
  - `shipTo` is narrower than `OrderAddress`: postal fields only, never the buyer's
    `email`/`phone` (PII crossing a new boundary; adapters keep it out of logs and
    errors, and `PaymentIntentError` still carries only gateway/retryable/status/code).
  - `createOrderFromCart` populates it at **both** `createIntent` call sites (the
    fresh checkout and the I1 replay) through one shared `intentInputFor` helper,
    reading `title` off `order_items` — the **purchase-time snapshot**. A later
    product rename therefore cannot change what a replay sends, which is exactly what
    keeps Stripe's same-key idempotent retry byte-identical rather than rejected.

- **Adapters (`[Adapters]`).** The Stripe adapter renders that structure into
  `description` and maps `shipTo` → `shipping[name]` + `shipping[address][…]`
  (`region` → Stripe's `state`; country upper-cased to the ISO-3166 alpha-2 Stripe
  demands; absent optional fields omitted, never sent empty). India requires
  `shipping` alongside the description for exports of physical **goods**; a digital
  order simply has no ship-to and sends none. New exported
  `formatStripeIntentDescription` with a deterministic contract: `"<qty> × <title>"`
  joined with `", "`, source line order preserved (never sorted), each title
  whitespace-collapsed and clamped to `STRIPE_DESCRIPTION_TITLE_MAX_LENGTH` (120)
  **code points** (so an astral-plane title can never be cut into a lone surrogate),
  whole lines appended while the result plus its `" + N more"` remainder marker still
  fits `STRIPE_DESCRIPTION_MAX_LENGTH` (1000), and a `"Order <id>"` fallback so a
  line-less order still never sends an EMPTY description. `StripeTransport`'s
  create-intent input is now the exported `StripeCreatePaymentIntentInput`;
  `URLSearchParams` keys are set in a fixed order so two identical calls serialize a
  byte-identical body.

Unchanged on purpose: the **offline** (no `secretKey`) path — still the deterministic
`pi_<orderId>` handle, byte-identical, so dev/test/e2e are unaffected — and the
exponent-2 `STRIPE_UNSUPPORTED_CURRENCIES` gate, which still fires before any
description work and before any network call (the two do not interact: the
description carries no money).
