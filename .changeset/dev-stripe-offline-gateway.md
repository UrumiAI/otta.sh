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
`payment_intent.succeeded` that passes the same HMAC check as production. The site-baked
define is the primary gate: a site that never bakes it can never arm the path (the staging
site bakes it only under `astro dev`, and `astro build` refuses the variable). The
`import.meta.env.DEV` check is defence in depth: the published `dist` keeps the expression,
the consumer's bundler folds it to `false` in any build with `NODE_ENV=production`, and a
bundle that never rewrites it reads it as off. A configured secret key always gets the live
gateway.
