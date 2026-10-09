---
"@otta-sh/plugin": minor
---

New build-time env var `OTTA_EXTRA_ALLOWED_HOSTS` (comma-separated hostnames) adds hosts to
the plugin's `ctx.http` egress allowlist, through the new `extraAllowedHosts` field on
`InProcessEgressUrls` (`parseExtraAllowedHosts` validates it at build time,
`normalizeExtraHost` checks one entry). Entries must be public DNS hostnames. These fail
the build with an error naming each refused entry: wildcards; schemes, ports, paths or
userinfo; IP literals; single-label names; `localhost`, `local`, `internal`, `localdomain`,
`home.arpa`, `lan` and names under them; `nip.io`, `sslip.io`, `xip.io` and names under
them; and any Stripe host other than `api.stripe.com` (so `js.stripe.com` is refused;
listing `api.stripe.com` is a no-op). This is a build-time sanity check, not SSRF
protection: EmDash's egress check on the resolved IP is the runtime guard.

Removed the now-unused `IN_PROCESS_EGRESS_URLS` constant and `resolveInProcessEgress`
function from `@otta-sh/plugin`: after the x402 removal they always returned `{}`, and no
code read them. `ALLOWED_HOSTS` and `resolveAllowedHosts` are unchanged.
