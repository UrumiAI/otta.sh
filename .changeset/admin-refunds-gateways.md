---
"@otta-sh/plugin": patch
---

Admin refunds reach the payment gateways again (#303). `makeAdminClients` now resolves the
same gateways as `makeCommerceClient` (a shared `resolvePaymentGateways`) and passes them to
`InProcessAdminOrdersClient`, which gains a `gateways` constructor option. With Stripe
configured, a console refund is issued with `POST /v1/refunds` over `ctx.http`, carrying the
refund's idempotency key; an x402 order's refund is recorded as a manual, off-platform refund.
With no gateway configured for an order's method, a refund is still refused
`409 REFUND_GATEWAY_UNAVAILABLE`.
