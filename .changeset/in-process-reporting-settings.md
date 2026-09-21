---
"@otta-sh/plugin": patch
---

Serve the admin Reports screen, the Settings form and the Products console's
low-stock band from the plugin's own document store.

The reporting + settings surface (`getRevenue`, `getOrdersByStatus`,
`getTopProducts`, `getLowStock`, `getSettings`, `updateSettings`) now sits
behind `makeAdminClients`, and the transport-agnostic client contract suite runs
every one of those six methods against it.

A settings save that fails now states WHY structurally, on
`UpdateSettingsResult.reason` (`"validation"`, `"superseded"`, `"unavailable"`).
This is a RATIFIED change to a published surface — proposed and approved
2026-09-16 under work order 02, not an incidental widening.
Callers should branch on `reason` first; the numeric `status` stays as an
optional legacy fallback, and nothing synthesizes one any more. A lost
compare-and-set is reported as `"superseded"`, and the Settings form now says so
rather than inviting a retry that cannot win.
