---
"@urumi/service": minor
"@urumi/plugin": minor
---

Move the machine write-gate token to a dedicated `X-Service-Token` header (ADR-0007),
freeing `Authorization: Bearer` for customer session auth, and thread it from write-only
plugin kv.

The `SERVICE_API_TOKEN` write gate previously consumed `Authorization: Bearer` — which is
also the customer session credential. Because the gate runs first for every non-GET, enabling
the service secret would 401 every session route (`/auth/logout`, `/me/*` mutations) before
session auth ran. The token now rides its own header; the two no longer collide.

- **Service (`[Service]`).** `requireBearerToken` → `requireServiceToken`: reads only
  `X-Service-Token` (never `Authorization`), and its 401 drops `WWW-Authenticate: Bearer`
  (a custom header has no registered challenge) — now byte-identical to the `X-Internal-Token`
  gate. The `SERVICE_API_TOKEN` env-var name and the Stripe-webhook exemption are unchanged.
  Routes that also carry `X-Internal-Token` (`PUT /settings`, `POST /admin/orders/:id/transition`,
  rules-admin POSTs, `/internal/*`, `/entitlements/grant`) now require BOTH headers when both
  secrets are set.
- **Plugin (`[Plugin]`).** All three clients (`HttpCommerceClient`, `ReportingSettingsClient`,
  `AdminOrdersClient`) forward the token as `X-Service-Token`, sourced at runtime from
  write-only `ctx.kv` (`settings:serviceToken`) via the new fail-closed `serviceTokenFromKv`
  helper — never baked into the bundle (stays sandbox-clean). A new masked, write-only
  "Service token (X-Service-Token)" field on the Settings page provisions it. Note the gate
  blocks POST *reads* too (`getCommerceBatch` for PDP/PLP, the login pre-auth POSTs), so those
  paths now depend on kv provisioning when the service secret is set.

Deploy ordering and rotation guidance are documented in ADR-0007 and `sites/staging/README.md`:
provision the kv token before flipping the service secret, and rotate the two in lockstep
(sync hooks are fire-and-forget with no reconcile cron, so a mismatch drops writes silently).
