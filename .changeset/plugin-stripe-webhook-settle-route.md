---
"@otta-sh/plugin": minor
---

The plugin can now settle a Stripe webhook itself, on a new PUBLIC route
`webhooks/stripe/settle` (work order 02, INC-C1b). Folding the commerce service in
leaves no second deployable for Stripe to post to, so the receiver moves into the
plugin — and with it the verification that makes a receiver trustworthy.

- **The route is public because a webhook is always unauthenticated**, and EmDash routes
  an anonymous request only through its public dispatcher. `public: true` here means "no
  session", never "no auth": `StripePaymentGateway.verifyConfirmation` performs a real
  `crypto.subtle.verify` HMAC check against `settings:stripeWebhookSecret` inside the
  isolate, and a delivery that cannot produce that signature cannot settle anything. The
  check is unconditional — no branch can skip it.
- **A second, cheaper gate runs first.** A new write-only kv secret,
  `settings:otta-wh-token`, is compared in CONSTANT TIME (`constantTimeEquals` — XOR
  across every byte, never `===`, and never `node:crypto`, which the sandbox cannot
  import) against an `X-Otta-Wh-Token` header, before any other kv read and before the
  domain is entered, so an unattributed request costs one kv get. Unset, it passes
  through — mirroring the service's own `requireServiceToken` — which degrades a
  deployment that never provisioned one to "Stripe HMAC only" rather than to "every
  webhook 401s". The token is provisioned from the Settings screen like every other
  payment secret, and like them it is never rendered back.
- **The body travels as base64 and the status travels as a field.** The route framework
  JSON-parses the request before a handler runs and re-wraps the return at HTTP 200,
  while a Stripe HMAC covers the exact delivered bytes and Stripe's retry logic keys on
  the status. So the caller sends the raw bytes base64-encoded and replays the returned
  status onto the real response, using the same `SettleResult` table the service's own
  receiver used — Stripe's retry semantics do not drift because the transport changed.
- **Replay stays the domain's job.** `settleOrder` claims the Stripe event id under a
  UNIQUE constraint and re-drives only state-guarded steps; the route adds no second
  dedupe that could disagree with it.

New exports: `STRIPE_WEBHOOK_SETTLE_ROUTE`, `createStripeWebhookSettleHandler`,
`settleResultToResponse`, `WEBHOOK_EDGE_TOKEN_KEY`, `WEBHOOK_EDGE_TOKEN_HEADER`,
`webhookEdgeTokenFromKv`, `constantTimeEquals`, and the route's input/result types.
`@otta-sh/payments-stripe` is now a runtime dependency, bundled into the plugin artifact.
