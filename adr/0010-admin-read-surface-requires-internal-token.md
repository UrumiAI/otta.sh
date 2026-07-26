# 0010. The admin read surface requires `X-Internal-Token`

- Status: accepted
- Date: 2026-07-26
- Refines: ADR-0007 (the `SERVICE_API_TOKEN` write gate and its GET/HEAD exemption)

## Context

ADR-0007 describes the `SERVICE_API_TOKEN` write gate as leaving "GET/HEAD open as the
storefront read surface". That sentence is true about the **gate** and false as a statement
about the **service**: the gate exists to stop an anonymous machine caller from *writing*,
so exempting reads from it says nothing about who may read. It is not an authorization
decision. A reader of 0007 in isolation would reasonably conclude that every GET is
deliberately public — and that is how the codebase drifted.

An API-contract audit found seven merchant-configuration reads that no gate covered:

| Endpoint | Leaks |
|---|---|
| `GET /admin/shipping/zones` | zone names/regions |
| `GET /admin/shipping/zones/:zoneId/methods` | the method registry |
| `GET /admin/shipping/methods/:methodId/rates` | rate amounts, free-shipping thresholds |
| `GET /admin/tax/classes` | the tax-class registry |
| `GET /admin/tax/rates` | rate basis points per zone |
| `GET /admin/coupons/:code` | full coupon economics — `amountCents`, `rateBps`, `capCents`, `minSubtotalCents`, `maxUses`, `maxUsesPerCustomer` and live `usesCount` — to anyone who guesses a code |
| `GET /settings` | `holdTtlMinutes`, `lowStockThreshold` |

Each is reachable with **no credential at all**, whether or not either secret is configured.
The inconsistency is the tell: the sibling `GET /admin/coupons` *list* was guarded, every
`/reports/*` read was guarded, `PUT /settings` was guarded — the same data was protected on
one route and open on its neighbour. Coupon-by-code is the sharp edge: code enumeration
against an open endpoint reads out a merchant's entire discount economics.

A second, structural finding shaped the fix. The obvious remedy — a blanket
`app.use("/*")` inside each admin sub-app — is opt-in security wearing the costume of
default-deny. Hono merges a sub-app's middleware into the parent **at mount time**, so it
covers only what is registered after it. `adminRoutes` and `rulesAdminRoutes` are both
mounted at `/admin`; a blanket guard inside the second never runs for the first. Probed
against the installed Hono (4.12.x) and pinned by a test, so this is measured, not inferred:

```
parent.route("/admin", adminRoutes)          // registered first
parent.route("/admin", rulesAdminRoutes)     // has app.use("/*")
GET /admin/orders       → guard did NOT run
GET /admin/tax/classes  → guard ran
```

So a sub-app guard leaves any route mounted earlier at the same prefix silently open —
exactly the failure mode being fixed.

## Decision

1. **Passing the write gate is not authorization.** "GET/HEAD skip the `X-Service-Token`
   check" ≠ "the route is public". Every route owns its own authorization; ADR-0007's
   sentence is scoped to the gate and is annotated in place to say so.

2. **The admin read surface — `/admin/**`, `/reports/**`, `/settings` — requires
   `X-Internal-Token`**, reads and writes alike. Unconfigured token ⇒ **503**
   (`internal endpoints disabled`), mismatch ⇒ **401**. Fail-closed, never silently open,
   matching the existing `requireInternalToken` contract.

3. **The guard is registered at the PARENT app**, in `createApp`, immediately after the
   write gate and before any `app.route(...)`:

   ```ts
   app.use("/admin/*", adminGuard);
   app.use("/reports/*", adminGuard);
   app.use("/settings", adminGuard);    // exact path, deliberately, as well as:
   app.use("/settings/*", adminGuard);
   ```

   Parent-level and registered first is the whole point: it makes those prefixes
   default-DENY, so a route added later — in any sub-app, by an author who forgets an
   inline check — is closed rather than public. The sub-app blanket guards and the 17
   per-route calls in `admin.ts` stay as defense-in-depth; they are no longer the fail-safe.
   Both `/settings` forms are registered because the leaf route is the bare prefix; the
   wildcard happens to match it on 4.12.x, and the exact-path registration removes the
   dependency on that staying true across a Hono minor.

4. **The public read surface is enumerated and closed.** Only these stay reachable without
   a token: `GET /health`, `GET /carts/:cartId`, `GET /products/:id/commerce`,
   `GET /orders/:orderId` (capability-URL scoped, and redacted — a separate change),
   `GET /me/*` (session Bearer, its own auth), `GET /entitlements/check` (its own route
   auth, ADR-0011). A regression test pins that this list stays reachable, so gating the
   admin surface cannot creep into the storefront.

5. **A route under these prefixes that needs looser auth is mounted OUTSIDE them, never
   exempted here.** ADR-0007 rejected exemption sprawl for the write gate; the same rule
   applies. The gate's single method+path exemption (the Stripe webhook, which carries its
   own HMAC auth) is the ceiling, not a precedent.

6. **A public response is a whitelist projection.** New fields on an `Order` or on config
   are private by default. The habit this reverses — "additive fields are harmless, existing
   consumers ignore them" — is how the ADR-0009 shipping-address snapshot became publicly
   readable without anyone deciding it should be.

## The public order read surface

`GET /orders/:orderId` is the one member of the public list that is neither anonymous-safe
by nature nor protected by a credential: it is a **capability URL**, so guessing or leaking
the order id is the whole authentication story. It therefore returns a redacted whitelist
projection (`serializePublicOrder`) — `buyerRef`, `customerId`, `shippingAddress`,
`reconciliationFlag` and `reconciliationResolution` are omitted entirely, and
`fulfillment`/`cancellation` are trimmed of staff identity and audit witnesses. Two clauses
belong in this ADR rather than in that change's own notes, because they outlive it:

- **A guest has no session, so `GET /me/orders/:orderId` is not a fallback for this
  unauthenticated read.** Until a dedicated order-confirmation page exists, a guest cannot
  see their own ship-to via this route. That is accepted, not an oversight: the full view
  requires a session (`GET /me/orders/:orderId`) or a valid `X-Internal-Token`.
- **The widening path is a derived summary, never the raw snapshot.** If the confirmation
  UX ever needs a shipping hint, add a DERIVED `shippingAddressSummary` (city + country +
  a masked postal code). The raw `shippingAddress` snapshot (ADR-0009) must never be
  reopened on this route — reopening it would undo decision 6 above by the same "one more
  harmless field" step that created the leak.

## Consequences

- **Breaking for any deployment that never set `INTERNAL_API_TOKEN`.** The rules reads and
  `GET /settings` flip from 200 to **503**; with the token set but not sent, 401. Provision
  the token before deploying. `DEPLOYMENT.md` §4 and the troubleshooting table say so, and
  the provisioning order is unchanged from ADR-0007's runbook.
- **The plugin's admin screens must carry the token on reads.** Shipping, Tax and Coupons
  already did (`AdminRulesClient` attaches it to every GET). The Settings page did not: it
  built its client with the *service* token only, so `GET /settings` went out bare. It now
  sources both tokens through `readAdminTokens(ctx)` — the one place every guarded admin
  screen reads them — so the threading cannot drift again.
- **No bootstrap lockout.** With no token provisioned, the Settings page fails closed to a
  generic banner (no leaked status or URL) but still renders both token forms, so an admin
  can provision the token from the screen the gating affects.
- **Adding a route under `/admin`, `/reports` or `/settings` no longer requires remembering
  a guard.** The cost is that a genuinely public read cannot live under those prefixes —
  intentional, per decision 5.
