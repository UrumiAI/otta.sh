---
"@otta-sh/plugin": patch
"@otta-sh/service": patch
---

Retire the commerce-service deployment and the two-mode plumbing.

The `__OTTA_COMMERCE_MODE__` build-time define, `resolveCommerceMode`, the
`__OTTA_COMMERCE_SERVICE_URL__` define and `COMMERCE_SERVICE_BASE_URL` are all
gone. They existed for one purpose — running the extracted commerce-client
contract against the HTTP and in-process implementations side by side, to prove
them behaviourally identical before the HTTP transport was removed — and that
comparison is done. `makeCommerceClient(ctx)` and `makeAdminClients(ctx)` now
construct the in-process clients unconditionally.

`resolveAllowedHosts(egress)` no longer takes a mode or a service base URL: the
allowlist is Stripe's API host plus whichever of the deployment-supplied email
and x402-facilitator URLs parse to a hostname. No commerce-service host can
reach the `ctx.http` egress gate any more, because there is no commerce service
to reach.

The `settings:serviceToken` (`X-Service-Token`) and `settings:internalToken`
(`X-Internal-Token`) plugin-kv keys and their two admin Settings fields are
deleted with them. Both authenticated a caller *to the service*; with the
service folded in there is nothing to authenticate to, and a check that could
not fail is theatre. The write-only payment secrets are untouched.

`@otta-sh/service` loses its `wrangler.jsonc` and its `wrangler dev` / `wrangler
deploy` scripts — it is no longer a deployable.
