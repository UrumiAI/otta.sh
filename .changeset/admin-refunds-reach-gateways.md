---
"@otta-sh/plugin": patch
---

Admin refunds reach the payment gateways again (#303). `makeAdminClients` resolves them with the same `resolvePaymentGateways` the storefront checkout uses and hands them to `InProcessAdminOrdersClient`, which no longer hard-codes an empty map: a configured Stripe deployment refunds through Stripe (one `POST /v1/refunds` under the refund's idempotency key, none on a replay), an x402 order records a manual refund, and an unconfigured deployment still answers `409 REFUND_GATEWAY_UNAVAILABLE`.
