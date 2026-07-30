---
"@otta-sh/service": minor
---

Redact PII on the unauthenticated `GET /orders/:orderId` read.

`GET /orders/:orderId` is an unauthenticated, capability-URL-only read (guess
or leak the order UUID ⇒ a full read). It previously returned `serializeOrder`
verbatim; a new `serializePublicOrder` whitelist projection is now returned
unless the request carries a valid `X-Internal-Token`, in which case the full
`serializeOrder` view is returned (matching `GET /admin/orders/:id` and
`GET /me/orders/:id`). An absent, empty, or wrong token DEGRADES to the
redacted view — never 401/503 — so a guest's "track my order" link keeps
working whether or not the internal token is even configured.

At `0.x`, changesets map a **minor** bump to a breaking change (there is no
major to take yet — semver's `0.x` carve-out). The `minor` here IS the
breaking bump, not a feature bump.

**BREAKING:** the unauthenticated `GET /orders/:orderId` response no longer
contains `buyerRef`, `customerId`, `shippingAddress`, `reconciliationFlag`,
`reconciliationResolution`, and trims `fulfillment` (drops `recordedBy`/
`recordedAt`) and `cancellation` (drops `detail`/`cancelledBy`). The full
projection now requires a session (`GET /me/orders/:id`) or a valid
`X-Internal-Token` (this same route).

`serializePublicOrder` is a WHITELIST, not a delete-list: a future additive
`Order` field is private by default on this route, reversing the "additive —
existing consumers ignore it" habit that made `shippingAddress` silently
public under ADR-0009.

A GUEST has no session, so `GET /me/orders/:id` is not a fallback for this
unauthenticated read — until a dedicated order-confirmation page exists, a
guest cannot see their own ship-to via this route. If that confirmation UX
ever needs a shipping hint, the widening path is a DERIVED
`shippingAddressSummary` (city + country + a masked postal code) — the raw
`shippingAddress` snapshot should never be reopened on this route.

Unchanged deliberately: `POST /checkout/orders` still returns the full order
(a write-gated POST whose caller just supplied the address);
`GET /me/orders/:id` (session-scoped) and the `admin.ts` order-detail/console
routes (internal-token-gated) stay full; `entitlements.ts`'s `POST /grant`
also calls the full `serializeOrder`, but it already sits behind
`requireInternalToken`, so it is unaffected.
