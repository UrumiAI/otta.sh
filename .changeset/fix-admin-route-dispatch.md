---
"@otta-sh/plugin": minor
---

Fix the admin Reports/Settings pages 404 under EmDash's admin shell, and deliver
the admin token the guarded reads/writes need.

EmDash renders every plugin admin page by `POST /plugins/{id}/admin` with a
`BlockInteraction` body (`{type:"page_load", page:"/reports"}`) and resolves the
route by the literal key `"admin"`, dispatching internally on `type` +
`page`/`action_id` — exactly like EmDash's own audit-log/atproto plugins. The
plugin previously registered per-page keys `"admin/reports"`/`"admin/settings"`
(with no `"admin"` route), so both pages returned `ROUTE_NOT_FOUND` 404.

- **Single `admin` dispatch route.** New `admin/admin-route.ts` exports
  `ADMIN_ROUTE` + `createAdminRouteHandler()`: an IO-free dispatcher that
  constructs the Reports and Settings sub-handlers once and forwards the
  unchanged `routeCtx`/`ctx` on `type === "page_load"` + `page`
  (`/reports` / `/settings`) or on a Settings `action_id`
  (`save-display`/`save-operational`/`save-token`); unrecognized interactions
  return `{ blocks: [] }`. `plugin.ts` now registers only `[ADMIN_ROUTE]`. The
  misleading `REPORTS_ROUTE`/`SETTINGS_ROUTE` constants are removed.
- **Settings surfaced in the admin nav.** New exported `SETTINGS_PAGE`
  (`/settings`, Gear icon) added to the trusted descriptor's `adminPages`
  alongside `REPORTS_PAGE`.
- **Admin token via a write-only kv secret.** EmDash's `page_load` carries no
  token, so the guarded `/reports/*` reads and `PUT /settings` failed auth. A
  masked `secret_input` field (`internalToken`) on the Settings form persists
  the token write-only to `ctx.kv` under `settings:internalToken` (the
  webhook-notifier pattern): saved only on a non-empty submit (a blank submit
  never clobbers), never rendered back into any block, toast, or error. Reports
  and the operational save now source the token from kv, not the interaction.
- **No raw HTTP status/URL in error banners.** The Reports and Settings
  load-tier failure banners now show a generic remediation message instead of
  echoing the service's HTTP status/URL.

Capabilities stay exactly `content:read` + `network:request`; the dispatcher is
IO-free and adds no egress — all proven under the workerd-on-Node sandbox.
