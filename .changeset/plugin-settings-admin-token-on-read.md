---
"@otta-sh/plugin": patch
---

Settings page: send the admin token on the `GET /settings` read, not only on the write.

`createSettingsFormHandler` built its `ReportingSettingsClient` with the **service** token
only, so `client.getSettings()` went out with no `X-Internal-Token` — while
`updateSettings` took the admin token per-call. That worked only because the read was
ungated; with `GET /settings` now behind the internal token (ADR-0010) the page would fail
closed on every load.

Both tokens now come from `readAdminTokens(ctx)` — the same helper the Shipping, Tax and
Coupons pages already use — and the `save-operational` path reuses that `adminToken`
instead of re-reading kv, so the read and the write cannot disagree. With no token
provisioned the page still fails closed to a generic banner (no leaked status or URL) and
still renders both token forms, so there is no bootstrap lockout.
