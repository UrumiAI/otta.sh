---
"@otta-sh/domain": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/service": minor
---

Live Stripe `paymentIntents.create` in `StripePaymentGateway.createIntent` when a
`secretKey` is configured — the repo's first money-IN provider call. Without a
`secretKey` the OFFLINE deterministic handle is byte-identical to before, so every
existing suite, staging and e2e keep running unchanged.

**`@otta-sh/payments-stripe`**

- `StripeTransport` gains a **required** `createPaymentIntent` method (with
  `StripeCreatePaymentIntentResult`). **This breaks any external `StripeTransport`
  implementer** — pre-1.0, so a minor bump, but the method must be added.
  `createStripeHttpTransport` implements it: `POST /v1/payment_intents`,
  form-encoded `amount` (integer minor units, straight through — no float math),
  lowercase `currency`, `metadata[order_id]` (THE settlement key `normalizeEvent`
  reads back off the webhook) and `automatic_payment_methods[enabled]`, with our
  domain `idempotencyKey` sent as Stripe's native `Idempotency-Key`.
- Only two failure classes — network/abort, 5xx, 429 and 409 are `retryable`, any
  other 4xx `terminal`: creating an intent moves no money, and the native key makes
  a same-key retry return the *same* intent, so there is no `ambiguous` case.
- New `requestTimeoutMs` option (default 30 s, `AbortSignal.timeout`) so a hung
  Stripe cannot hang a Worker checkout. The `secretKey` never reaches an error
  message, `cause`, or any enumerable field.
- **The live path is two-decimal currencies ONLY, and fails closed.** Our minor
  units are hundredths everywhere while Stripe's `amount` is each currency's own
  smallest unit, so a zero-decimal currency (JPY, KRW, …) would be charged 100×
  and a three-decimal one (KWD, …) mis-scaled the other way. The new exported
  `STRIPE_UNSUPPORTED_CURRENCIES` deny-list (Stripe's documented zero- and
  three-decimal sets) is checked **before any network call**, throwing a terminal
  `PaymentIntentError` with provider code `unsupported_currency` — so checkout
  answers 502 instead of overcharging. The offline path is not gated (it moves no
  money). Lifting the restriction needs an exponent-aware money boundary.

**`@otta-sh/domain`**

- New exported `PaymentIntentError` (`gateway`, `retryable`, and log-only
  `providerStatus` / `providerCode`) — the typed throw `createIntent` uses to
  report a provider failure, gateway-agnostic and IO-free.
- New `CreateOrderFailure` member **`PAYMENT_INTENT_FAILED`** (additive union
  widening — consumers with exhaustive switches must handle it).
  `createOrderFromCart` catches `PaymentIntentError` **by type only** at both
  `createIntent` call sites (anything else still propagates) and logs the provider
  status/code at the mapping site. The `pending` order row is deliberately kept:
  `expireOrders` sweeps it at TTL (releasing reservations *and* the coupon), and a
  same-key retry re-issues the same intent against the same order.
- The idempotent-replay short-circuit no longer calls `createIntent` when the
  replayed order has left `pending` (paid / failed / expired / cancelled): now
  that this is a live provider call, a gateway outage must not turn a replay of an
  already-PAID order into a 502. Such a replay returns the order with an empty
  handle — `intentId: ""`, `clientAction: { kind: "none" }` (no new intent was
  minted and none is needed); the wire shape is unchanged.
- **Fix:** `createOrderFromCart`'s outer catch released the coupon redemption for
  *any* throw after redeem, including throws after the order row was inserted — the
  order kept its discounted total while the use was handed back. An `orderMinted`
  ownership handoff (symmetric with the existing `onFailure` plumbing) now releases
  only while no order row owns the redemption. `RESERVATION_LOST` keeps its eager
  release (recovery there is a new cart + new key) — a deliberate asymmetry.

**`@otta-sh/service`**

- New `stripe-wiring.ts` (`wireStripeGateway`), used by both the Node bin and the
  Worker entry: `STRIPE_WEBHOOK_SECRET` without `STRIPE_SECRET_KEY` now means
  checkout hands buyers unpayable offline client secrets, so boot logs a loud
  `console.warn`. **Warn, never throw** — staging/e2e run without a secret key.
- `POST /checkout/orders` answers **502** `{ ok: false, reason:
  "PAYMENT_INTENT_FAILED" }` when the gateway call fails.
