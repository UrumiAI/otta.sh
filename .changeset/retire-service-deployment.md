---
"@otta-sh/plugin": minor
---

Retire the commerce-service deployment and the two-mode plumbing.

The `__OTTA_COMMERCE_MODE__` build-time define, `resolveCommerceMode`, the
`__OTTA_COMMERCE_SERVICE_URL__` define and `COMMERCE_SERVICE_BASE_URL` are all
gone. They existed for one purpose — running the extracted commerce-client
contract against the HTTP and in-process implementations side by side, to prove
them behaviourally identical before the HTTP transport was removed — and that
comparison is done. `makeCommerceClient(ctx)` and `makeAdminClients(ctx)` now
construct the in-process clients unconditionally.

**`minor`, not `patch`: the package index loses public exports.** Removed from
`@otta-sh/plugin`'s entry point:

- `COMMERCE_SERVICE_BASE_URL`
- `SERVICE_TOKEN_KEY`
- `serviceTokenFromKv`
- `resolveCommerceMode`
- the `CommerceMode` type

and `resolveAllowedHosts` changes signature: `resolveAllowedHosts(mode,
serviceBaseUrl, egress?)` becomes `resolveAllowedHosts(egress?)`. The allowlist
is now Stripe's API host plus whichever of the deployment-supplied email and
x402-facilitator URLs parse to a hostname. No commerce-service host can reach
the `ctx.http` egress gate any more, because there is no commerce service to
reach.

`readAdminTokens` and its `AdminTokens` type go too. They were never on the
package index — only on the internal `admin/scaffold` barrel — so they break no
published import, but any in-tree caller of that barrel loses them.

The `settings:serviceToken` (`X-Service-Token`) and `settings:internalToken`
(`X-Internal-Token`) plugin-kv keys and their two admin Settings fields are
deleted with them. Both authenticated a caller *to the service*; with the
service folded in there is nothing to authenticate to, and a check that could
not fail is theatre. The write-only payment secrets are untouched.

**Upgrade note — orphaned kv rows.** On a site already deployed against an
earlier version, the `settings:serviceToken` and `settings:internalToken` rows
(and their save-generation counters) survive in plugin storage and nothing
reads them any more. They are inert rather than harmful, and no migration
removes them — delete them by hand if you would rather not leave
credential-shaped rows sitting in kv.

**Test count.** The diff is a net **−69** tests (277 removed, 208 added).
Sixteen of those come from three suites deleted whole, each because its subject
no longer exists: `commerce-mode.test.ts` (5), `service-token-kv-wiring.test.ts`
(9), `admin-token-kv-isolation.test.ts` (2). The rest is the sandbox suites
being retrofitted from a stub HTTP server to real `ctx.storage` rows, which
folds per-transport duplicates into single cases.

**Known coverage gap:** the checkout **success** path loses the assertions that
rode on the HTTP tier's request log, so it is no longer covered past the point
where the Stripe gateway is called. Tracked as `#286`.

With the plugin no longer calling out to it, the commerce service stops being a
separately deployed Worker: there is one deployable left, and it is the site the
plugin runs in.
