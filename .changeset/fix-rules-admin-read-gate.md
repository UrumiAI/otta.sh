---
"@otta-sh/service": minor
---

Require the internal token on the whole admin **read** surface, not just the writes
(ADR-0010).

> At `0.x`, changesets map a **minor** bump to a breaking change (there is no major to take
> yet — semver's `0.x` carve-out). The `minor` here IS the breaking bump, not a feature bump.

**BREAKING:** any caller that read `/admin/**`, `/reports/**` or `GET /settings` without
`X-Internal-Token` now receives **401** (token set) or **503** (token unset) where it
previously received 200.

The shipping/tax/coupon admin GET reads (`GET /admin/shipping/zones`,
`/admin/shipping/zones/:zoneId/methods`, `/admin/shipping/methods/:methodId/rates`,
`/admin/tax/classes`, `/admin/tax/rates`, `/admin/coupons/:code`) and `GET /settings`
called their store methods with no auth. Only the write siblings carried
`requireInternalToken`, and the app-level `SERVICE_API_TOKEN` write gate exempts GET/HEAD
by design — so these reads were reachable with **no token at all**, regardless of whether
`SERVICE_API_TOKEN`/`INTERNAL_API_TOKEN` were set.

The sharpest leak was `GET /admin/coupons/:code`: it returns the full coupon config via
`serializeCoupon` — `amountCents`, `rateBps`, `capCents`, `minSubtotalCents`, `maxUses`,
`maxUsesPerCustomer` and the live `usesCount` — so an unauthenticated caller could
enumerate coupon codes and read their entire discount configuration and remaining usage.
The storefront never needs this (coupon validation and quotes are computed server-side in
`POST /checkout/quote`), so it was never a deliberate public affordance. This also
contradicted `DEPLOYMENT.md` §4, which lists the `/admin/*` rules **CRUD** among endpoints
that answer 503 ("disabled — never silently open") when `INTERNAL_API_TOKEN` is unset.

Fix: the authoritative guard is registered at the **parent app** in `createApp` —
`app.use` on `/admin/*`, `/reports/*`, `/settings` and `/settings/*`, before any route is
mounted — so those prefixes are default-DENY and a route added later without its own check
is still closed. A sub-app guard could not do this: Hono merges sub-app middleware at mount
time, so a blanket guard inside `rulesAdminRoutes` never covers `adminRoutes`, the sibling
sub-app mounted at `/admin` before it (probed and test-pinned). Sub-app and per-route guards
remain as defense-in-depth; the now-redundant inline calls in `rules-admin.ts` are gone —
one guard, no drift.

**Operational note:** a deployment that never set `INTERNAL_API_TOKEN` now gets 503 on the
rules and settings reads. Provision the token before deploying — see `DEPLOYMENT.md` §4 and
ADR-0010's Consequences. No wire change for authorized callers.
