# @urumi.ai/otta-mcp

Admin MCP tools for [Otta](https://github.com/UrumiAI/otta.sh). It lets a store admin or developer
run an Otta store from an AI agent (Claude Code, Claude Desktop) over the MCP endpoint EmDash
already serves at `/_emdash/api/mcp`.

There is no new server, transport or login. The package wraps the Otta plugin: `withMcp(plugin)`
adds one private route per tool and the matching `mcp.tools` entry, under the plugin's own id
(`otta`). EmDash exposes each tool as `otta__<name>`. Why it is shaped this way:
[ADR-0046](../../adr/0046-admin-mcp-tools-ship-as-a-plugin-wrapper.md).

It is opt-in per site and off by default. A site that does not opt in never installs it.

## Enabling it

These steps were checked against EmDash 1.5.0's admin and API code.

### 1. Opt the site in, and deploy

**A store built on `@urumi.ai/otta-store`** (the one-click template): install this package at the
same version as `@urumi.ai/otta-store`, then set `mcp: true`:

```bash
npm install @urumi.ai/otta-mcp@<your @urumi.ai/otta-store version>
```

```js
// astro.config.mjs
integrations: [otta({ template: 1, mcp: true })],
```

The template contract stays 1. Without the package installed, the build fails with
`otta({ mcp: true }) needs @urumi.ai/otta-mcp installed`.

**A site with its own Otta descriptor:** point the descriptor's entrypoint at this package's
trusted entry. Nothing else in the descriptor changes.

```ts
entrypoint: "@urumi.ai/otta-mcp/trusted", // was "@urumi.ai/otta-plugin/trusted"
```

Deploy. The tools exist now, but they stay off until an admin turns them on.

### 2. Turn on the tools and consent (Admin)

1. In the EmDash admin, open **Plugins** (`/_emdash/admin/plugins-manager`). Otta must be enabled.
   Its card shows an "N MCP tools" badge.
2. On the Otta card, click **Expand details**. The **Agent access** section lists every tool:
   its `otta__<name>`, a **Destructive** badge where it applies, its route and its permission.
3. Turn on the **Agent access** switch ("Enable plugin MCP tools"). **This is the consent.**
   There is no separate dialog: EmDash stores the exact tool list shown when you turn it on.

The same through the API, from a signed-in admin session (needs `plugins:manage`):
`PUT /_emdash/api/admin/plugins/otta/mcp` with body `{"enabled": true}`.

### 3. Create an API token with scope `mcp:tools:otta` (Admin)

1. Open **Settings > API Tokens** (`/_emdash/admin/settings/api-tokens`) and click
   **Create Token**.
2. Give it a name. Under **Scopes**, tick **Plugin tools: otta** ("Invoke only this plugin's
   enabled MCP tools"). That is the scope `mcp:tools:otta`. Pick an expiry (the default is 30
   days).
3. Click **Create Token** and copy the token (`ec_pat_…`). It is shown only once.

Only an Admin can create tokens, and a token acts as the user who created it, so the tools see an
Admin. The scope `mcp:tools` (every enabled plugin's tools) works too. `admin` does **not**: EmDash
never lets `admin` stand in for a plugin tool scope.

The same through the API, from a signed-in admin session: `POST /_emdash/api/admin/api-tokens`
with body `{"name": "agent", "scopes": ["mcp:tools:otta"], "expiresAt": "<ISO date>"}`
(`expiresAt` is optional). The response carries the token, once.

### 4. Connect the agent

```bash
claude mcp add --transport http otta https://<site>/_emdash/api/mcp \
  --header "Authorization: Bearer <token>"
```

### A changed tool list needs consent again

EmDash compares the tool list it serves with the one the admin consented to: each tool's name,
description, route, permission, destructive flag and input and output schemas. **If an Otta
upgrade changes any of them, EmDash hides every Otta tool until an admin consents again.** The
Agent access switch still shows on. Turn it off and on again (or send the `PUT` above again) to
consent to the new list.

## Who can call the tools

Every tool needs the `plugins:manage` permission (Admin), the same as the Otta admin screens. A
token without `mcp:tools:otta` gets `INSUFFICIENT_SCOPE`; a non-admin user gets
`INSUFFICIENT_PERMISSIONS`. Writes go through the same guarded admin operations the admin uses, so
idempotency, the refund ledger and the confirm steps hold for an agent too. Payment secrets are
never read back.

EmDash refuses every Otta tool, reads included, while a site export is running: it marks no
plugin tool read-only.

## Errors

A call the tool itself refuses is an MCP tool error whose `_meta.code` is a stable code (for
example `NOT_FOUND`, `STALE`, or `INVALID_INPUT` for a value the store refuses). Money is always
integer minor units plus a currency.

Every tool's input is a strict schema: a missing or mistyped field, or an unknown key (a typo such
as `maxUse`), is refused, never ignored. Through `/_emdash/api/mcp` that refusal comes from the MCP
SDK, which checks the input against the schema before the tool runs: an MCP tool error whose text
starts `Input validation error`, with **no** `_meta.code`. Only a direct call to the plugin route
(`/_emdash/api/plugins/otta/mcp/<tool>`) answers a schema refusal as `INVALID_INPUT`.

The two payment-secret tools never echo what was sent. On the route, their schema refusals name
only each problem's field and kind. On the MCP path, zod's messages name the allowed options or the
received type, never a submitted value, and their unknown-key refusal does not name the key.
