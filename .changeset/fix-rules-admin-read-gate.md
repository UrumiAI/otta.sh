---
"@urumi/service": patch
---

Require the internal token on the Phase-6 rules-admin **reads**, not just the writes.

The shipping/tax/coupon admin GET reads (`GET /admin/shipping/zones`,
`/admin/shipping/zones/:zoneId/methods`, `/admin/shipping/methods/:methodId/rates`,
`/admin/tax/classes`, `/admin/tax/rates`, `/admin/coupons/:code`) called their store
methods with no auth. Only the POST siblings carried `requireInternalToken`, and the
app-level `SERVICE_API_TOKEN` write gate exempts GET/HEAD by design (that is the
storefront read surface) — so these reads were reachable with **no token at all**,
regardless of whether `SERVICE_API_TOKEN`/`INTERNAL_API_TOKEN` were set.

The sharpest leak was `GET /admin/coupons/:code`: it returns the full coupon config via
`serializeCoupon` — `amountCents`, `rateBps`, `capCents`, `minSubtotalCents`, `maxUses`,
`maxUsesPerCustomer` and the live `usesCount` — so an unauthenticated caller could
enumerate coupon codes and read their entire discount configuration and remaining usage.
The storefront never needs this (coupon validation and quotes are computed server-side in
`POST /checkout/quote`), so it was never a deliberate public affordance. This also
contradicted `DEPLOYMENT.md` §4, which lists the `/admin/*` rules **CRUD** among endpoints
that answer 503 ("disabled — never silently open") when `INTERNAL_API_TOKEN` is unset.

Fix: mount a single blanket `app.use("/*")` internal-token guard at the top of
`rulesAdminRoutes` — mirroring the `/reports/*` guard — and drop the now-redundant
per-`POST` inline checks. Every rules-admin route (reads and writes) now requires
`X-Internal-Token`: **503** when no internal token is configured, **401** on a missing or
wrong token. Any future route added under this surface is protected by default rather than
opt-in. No wire change for authorized callers (the admin console already sends the token).
