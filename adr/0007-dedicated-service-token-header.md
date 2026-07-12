# 0007. The machine write-gate token uses a dedicated `X-Service-Token` header

- Status: accepted
- Date: 2026-07-12
- Refines: the `SERVICE_API_TOKEN` write gate (introduced with the Worker entry, D9); relates to ADR-0006 (trusted in-process deployment) and #46/#47/#48 (kv-backed admin token provisioning)

## Context

The commerce service has a `SERVICE_API_TOKEN` write gate: when the secret is set, every
non-GET/HEAD request must present it, else 401 (GET/HEAD stay open as the storefront read
surface; the Stripe webhook is an exact method+path exemption with its own HMAC auth). As
first written, the gate consumed **`Authorization: Bearer <serviceToken>`**.

The Phase 5–7 rebase surfaced a collision: `Authorization: Bearer` is **also** the customer
session credential. `POST /auth/logout` and the `/me/*` mutations authenticate a shopper by
the session token in `Authorization: Bearer`. Because the write gate runs FIRST for every
non-GET (`app.use("*")`), enabling `SERVICE_API_TOKEN` would 401 every session route at the
gate — a customer's Bearer carries a **session** token, not the service token — before
session auth ever ran. The two consumers of one header are mutually exclusive: you cannot
both gate machine writes and authenticate customers on the same `Authorization: Bearer`.

Separately, the plugin had no way to present the token at all: the storefront/admin clients
call the service over `ctx.http`, and the token was neither baked into the bundle (that
would break the sandbox-clean contract, DEVELOPMENT.md §5) nor read anywhere at runtime.

## Decision

1. **The machine write-gate token moves to a dedicated `X-Service-Token` header.**
   `Authorization: Bearer` is owned **solely** by customer session auth. The gate reads only
   `X-Service-Token`; it ignores `Authorization` entirely. A session route now needs BOTH
   headers when the service secret is set (the gate's `X-Service-Token` + the session's
   `Authorization: Bearer`), and the two no longer collide.
2. **The 401 drops `WWW-Authenticate: Bearer`.** A custom header is not the Bearer scheme, so
   there is no registered challenge to advertise. The gate's 401 is now byte-identical to the
   `X-Internal-Token` gate's: `{ok:false,error:"unauthorized"}`, status 401, no challenge
   header.
3. **The `SERVICE_API_TOKEN` env-var name is unchanged.** Only the wire header moves; the
   service secret and its config plumbing stay as-is.
4. **The plugin obtains the token at runtime from write-only `ctx.kv`
   (`settings:serviceToken`)**, admin-provisioned via a masked, write-only Settings field —
   mirroring the admin `settings:internalToken` pattern (#46/#47/#48). NOT baked into the
   bundle. All three plugin clients (`HttpCommerceClient`, `ReportingSettingsClient`,
   `AdminOrdersClient`) read it via the shared `serviceTokenFromKv(ctx)` helper and forward
   it as `X-Service-Token` — `HttpCommerceClient` on every request (uniform; GET is
   gate-exempt but the header is harmless), the two admin clients on their non-GET calls.

## Consequences

- **Bundle stays sandbox-clean.** No secret in the bundle, `wrangler.jsonc` `vars`, or git;
  the token lives only in em-dash's plugin-settings kv, read at runtime. `ctx.kv` is not
  capability-gated, so this adds **no new capability**.
- **Storefront reads themselves now depend on kv provisioning.** This is easy to
  underestimate: `getCommerceBatch` (PDP/PLP) and the login pre-auth calls
  (`/auth/login/request`, `/auth/login/verify`) are **POSTs**, so the write gate blocks them
  without the token. Once `SERVICE_API_TOKEN` is set, an unprovisioned `settings:serviceToken`
  401s not just writes but catalog rendering and login. Provision first (below).
- **The service token is MORE sensitive than the admin `internalToken`, not "the same
  posture".** A kv compromise now yields the **entire** write surface (carts, checkout,
  product commerce, entitlement grants, admin transitions, settings), whereas the admin token
  unlocks only `/admin` + `/internal`. Both share the same kv trust boundary (bounded by
  em-dash admin/DB security, the webhook-notifier trade-off), but the blast radius differs —
  treat `settings:serviceToken` as the most sensitive value the plugin holds.
- **Provisioning couples to #48** (per-env kv provisioning) and to the Settings form as the
  sole write path.
- **Deploy ordering (see the rotation runbook note below).** Provision the kv token BEFORE
  flipping the env's `SERVICE_API_TOKEN` service secret; the reverse order 401s storefront
  reads/writes and login in the window. Both are now runtime admin actions (no redeploy),
  closable in seconds.
- **Rotation runbook note (fire-and-forget hazard).** Rotating `SERVICE_API_TOKEN` on the
  service WITHOUT updating `settings:serviceToken` in the same env silently 401s every plugin
  call. The content-sync hooks (`content:afterSave/afterDelete/afterPublish/afterUnpublish`)
  are **fire-and-forget with no reconcile cron yet** — a 401'd sync is logged and then LOST
  until the next human save of that product re-fires the (idempotent) hook. So a mismatched
  rotation drops writes silently. Rotate in lockstep: set the new `settings:serviceToken`
  first (the service still accepts the old token), then rotate the service secret.

## Alternatives considered

- **Keep `Authorization: Bearer` and special-case the session routes** (exempt `/auth/*` and
  `/me/*` from the gate): reintroduces per-route exemption sprawl the gate was designed to
  avoid, and leaves the session routes ungated for machine callers. Rejected.
- **Bake the token into the bundle via a build-time `define`:** breaks sandbox-clean and makes
  rotation a rebuild+redeploy instead of a runtime kv write. Rejected.
