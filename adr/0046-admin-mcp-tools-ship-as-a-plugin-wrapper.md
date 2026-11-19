# 0046. Admin MCP tools ship as a plugin wrapper

- Status: accepted
- Date: 2026-11-17

## Context

Store admins and developers want to run an Otta store from an AI agent (Claude Code, Claude
Desktop) over MCP: orders, refunds, stock, coupons, shipping, tax, reports and settings, as the
Otta admin does them. EmDash already serves MCP at `/_emdash/api/mcp`, with API-token login, role
checks, and per-plugin enabling and consent. So the open question was where Otta's tools live,
not how to serve them.

EmDash sets these constraints (checked on 1.0.1 and on 1.5.0, which the repo pins):

1. **A plugin's data is private to it.** `ctx.storage` is namespaced by plugin id, so a separate
   EmDash plugin cannot read Otta's orders or products. The tools must run under the Otta
   plugin's own id.
2. **A plugin MCP tool runs one of its plugin's own routes.** `mcp.tools[name] = { description,
   route, input, output?, destructive? }`. EmDash registers the tool only if that route is
   non-public, a JSON POST contract, and declares a `permission` that is a real EmDash
   permission. The tool is exposed as `<pluginId>__<name>` (`otta__orders_list`).
3. **An admin must turn the tools on.** They are live only after an admin enables MCP tools for
   the plugin and consents to the exact tool list. EmDash stores that consent, so a changed list
   needs consent again. A scoped API token also needs the scope `mcp:tools:otta`.
4. **EmDash never marks a plugin tool read-only.** It passes only `destructiveHint`, so every Otta
   tool, reads included, is refused while a site export holds the write fence.
5. **The guards are not all in the admin clients.** Many live one layer up, in the Block Kit
   handlers: the refund ledger re-read and key derivation, stock keys built from the level the
   operator saw, coupon validation and whole-document replace, the one-zone-per-region check,
   and the settings saves with their two confirm steps. Calling the clients directly would skip
   them. (They were first extracted into shared admin operations, one PR per area, with no
   behaviour change.)

Three shapes were considered:

| | Approach | Trade-off |
|---|---|---|
| **A** | A new package, `@urumi.ai/otta-mcp`, that wraps the Otta plugin: `withMcp(plugin)` adds the MCP routes and `mcp.tools` under the same plugin id | An add-on with no circular dependency, reusing the admin operations. A site opts in by changing one entrypoint string |
| B | The tools inside `packages/plugin/src/mcp/` | Simplest, but every site would ship them, and the add-on was wanted separate |
| C | A standalone MCP server process calling the store over HTTP | Its own auth, deploy and hosting, and there is no admin JSON API to call. The most moving parts |

## Decision

**Approach A.** `@urumi.ai/otta-mcp` wraps the plugin object. `withMcp(plugin)` adds one private
route per tool (`mcp/<name>`, `permission: "plugins:manage"`, JSON POST) and the matching
`mcp.tools` entry, under the plugin's own id. Each route goes through the same admin operations
as the Otta admin, so idempotency, the refund ledger and the confirm steps hold for an agent.
Payment secrets are never read back.

The package depends on `@urumi.ai/otta-plugin` and never the other way. It exports `withMcp` and
the tool table, plus a `./trusted` entry, `withMcp(createOttaPlugin({ trustedHost: true }))`, for
an in-process registration.

**Opting in is per site, and off by default.**

- A site with its own descriptor points `entrypoint` at `@urumi.ai/otta-mcp/trusted` instead of
  `@urumi.ai/otta-plugin/trusted`. Nothing else changes: same id, version, storage,
  capabilities, allowed hosts, admin pages and settings schema.
- `@urumi.ai/otta-store` takes `otta({ template: 1, mcp: true })`, which makes that one switch.
  `@urumi.ai/otta-mcp` is an **optional** peer of the store (`peerDependenciesMeta`), so npm
  never installs it for a site that does not opt in. With `mcp: true`, the build-time peer
  check (ADR-0045) also checks `@urumi.ai/otta-mcp`. If it is missing, the build fails with
  "otta({ mcp: true }) needs @urumi.ai/otta-mcp installed". The integration then bundles it
  (`ssr.noExternal`) for the plugin's own reason: it imports the plugin. The playground build
  ignores the option, since it has no MCP endpoint.

**The template contract stays 1.** The option is new and off by default. A site that does not
set it builds exactly as before: same descriptor, same Vite settings, same dependencies (pinned by
`otta-plugin-descriptor.test.ts`, `mcp-option.test.ts` and the pack-build of the one-click
template). Opting in is a choice the merchant makes in their own files, not a change a release
asks for.

## Consequences

- **A changed tool list hides every Otta tool until an admin consents again.** EmDash's consent
  covers the whole list: each tool's name, description, route, permission, destructive flag and
  schemas. So an Otta release that adds or edits a tool needs the admin to re-consent (turn
  Otta's agent access off and on again). This is documented in the package README, not worked
  around.
- **Reads are refused during a site export,** like writes (constraint 4). Changing that needs an
  EmDash change.
- **Admin only.** Every tool needs `plugins:manage`, the same as the Otta admin screens. A token
  without the `mcp:tools:otta` (or `mcp:tools`) scope gets `INSUFFICIENT_SCOPE`, and a non-admin
  user gets `INSUFFICIENT_PERMISSIONS`. There are no read-only or per-tool roles.
- A site that opts in adds `@urumi.ai/otta-mcp` to its own dependencies at the same version as
  `@urumi.ai/otta-store`. The template's Dependabot group (`@urumi.ai/*`) keeps the two together.
- Product content (create, delete, title, images) stays with EmDash's own `content_*` tools. The
  Otta tools cover the commerce side only.

## Amendment: audit log (2026-11-19)

Every Otta MCP tool call is logged by `withMcp`, in the plugin's own storage (collection
`mcp_audit`): who called (EmDash's verified `ctx.user`, never the input), the IP and user agent,
the tool, its input (only the keys its schema knows, unknown keys counted; a `sensitiveInput`
tool's values are recorded as `"[redacted]"`; over 8 KB the input is truncated), how it ended (`ok`, `refused` with its code, `needs_confirmation`,
`error`), what it touched, and when. EmDash's own `audit_logs` row per call is left as it is; it
has no parameters, no Otta code and no screen.

- **Nothing runs unlogged.** The `started` entry is written before the tool runs, and a failed
  write refuses the call with `AUDIT_UNAVAILABLE`. A failed final update leaves the tool's answer
  unchanged and the entry `started` ("outcome unknown").
- **Read** through the read-only `audit_list` tool (the 47th) or the "Audit log" admin page.
  Nothing edits or deletes an entry, except retention.
- **Retention is one year.** Up to 20 expired entries are pruned after each logged call, using
  the `at` index. That keeps the work per call bounded, and a site with the add-on off never runs
  it. The cron sweep was not used: it belongs to the plugin, which has no audit collection when
  the add-on is off.
- **The descriptor declares it.** EmDash reads a plugin's collections and admin pages from its
  descriptor only, so with `mcp` on, `@urumi.ai/otta-store` adds the collection and the page. The
  declaration is exported as data by `@urumi.ai/otta-plugin`, since the store cannot import its
  optional peer. The page is served by `withMcp`, which wraps the plugin's `admin` route and passes
  every other interaction through.
- **One index, `at`.** EmDash's non-unique plugin indexes span every `_plugin_storage` row,
  so each costs about one D1 row write per stored row on the day it is built, and one more index
  entry on every later plugin-storage write. The log therefore declares only `at` (newest first,
  time range, prune) and matches `tool`, `actorId` and `status` in memory over a bounded scan.
  The cron sweep's index-build-day guard fingerprints the layout the site actually declares,
  the audit collection included when it is in `ctx.storage`, so the day `mcp` is turned on holds
  the daily-capped legs.
- **Limitation:** EmDash passes a plugin the user, not the token, so two agents sharing one user
  cannot be told apart. The recommendation is one EmDash user per agent.
