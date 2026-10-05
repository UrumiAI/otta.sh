---
"@otta-sh/plugin": patch
---

A dev-only offline Stripe gateway, so a local or CI e2e stack can create and settle
orders with no Stripe account (issue #378). `stripeGatewayFromCtx` still refuses to wire
a gateway without both the secret key and the webhook secret. The one exception: when the
site bakes the build-time define `__OTTA_DEV_STRIPE_OFFLINE__` as `true` AND the bundle is
a Vite dev build (`import.meta.env.DEV`), a webhook secret alone wires the adapter's
existing offline path. That path mints the deterministic `pi_<orderId>` handle, makes no
network call and is not refundable. The order is still marked paid only by a
`payment_intent.succeeded` that passes the same HMAC check as production. A production
Vite build folds `import.meta.env.DEV` to `false`, and a bundle built without Vite has no
`import.meta.env`, so no deployed build can turn it on. A configured secret key always
gets the live gateway.
