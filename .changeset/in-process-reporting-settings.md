---
"@otta-sh/plugin": patch
---

Serve the admin Reports screen, the Settings form and the Products console's
low-stock band from the plugin's own document store when the plugin runs
in-process, instead of calling the commerce service over HTTP.

The reporting + settings surface (`getRevenue`, `getOrdersByStatus`,
`getTopProducts`, `getLowStock`, `getSettings`, `updateSettings`) now has both
tiers behind `makeAdminClients`, and the transport-agnostic contract suite runs
every one of those six methods against both of them.

A settings save that fails now states WHY structurally, on
`UpdateSettingsResult.reason` (`"validation"`, `"superseded"`, `"unavailable"`).
This is a RATIFIED change to a published surface — proposed and approved
2026-09-16 under work order 02, not an incidental widening.
Callers should branch on `reason` first; the HTTP-only `status` stays as a
legacy fallback and is now optional, since the in-process tier has no HTTP
status and will not synthesize one. A lost compare-and-set is reported as
`"superseded"` and the Settings form now says so rather than inviting a retry
that cannot win.

Also fixes `ReportingSettingsClient.updateSettings`, which sent
`X-Internal-Token` only when a token was passed per call and ignored the one the
client was constructed with — a save could take a 401 on a screen whose reads
all succeeded.
