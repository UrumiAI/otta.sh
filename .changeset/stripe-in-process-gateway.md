---
"@otta-sh/plugin": minor
---

Wire the Stripe payment gateway into the in-process commerce composition root.

`make-commerce-client.ts` wired `x402` into `InProcessCommerceClient`'s payment gateways at the work-order-02 fold-in, but never wired `stripe` — the only payment method the storefront checkout actually requests (`checkout-routes.ts`'s `PAYMENT_METHOD` constant). Every card checkout resolved to no gateway and threw before the domain could return a typed reason, surfacing as an opaque failure page instead of a real Stripe PaymentIntent.

Added `payments/stripe-wiring.ts` (mirroring the existing `x402-wiring.ts` pattern) using the already-built `@otta-sh/payments-stripe` adapter. Fail-closed on both `settings:stripeSecretKey` and `settings:stripeWebhookSecret` together — a gateway that could create a live PaymentIntent but never verify its confirmation (or the reverse) is a half-armed state worse than off. `api.stripe.com` needed no new `allowedHosts` entry; it's the one constant the descriptor always grants.
