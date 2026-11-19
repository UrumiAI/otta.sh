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
trusted entry, and declare the [audit log](#audit-log)'s collection and page. EmDash takes a
plugin's collections and admin pages from its descriptor only. Without the collection, every tool
call is refused with `AUDIT_UNAVAILABLE`.

```ts
import {
	COMMERCE_STORAGE_COLLECTIONS,
	MCP_AUDIT_PAGE,
	MCP_AUDIT_STORAGE_COLLECTIONS,
} from "@urumi.ai/otta-plugin";

entrypoint: "@urumi.ai/otta-mcp/trusted", // was "@urumi.ai/otta-plugin/trusted"
storage: { ...COMMERCE_STORAGE_COLLECTIONS, ...MCP_AUDIT_STORAGE_COLLECTIONS },
adminPages: [/* the Otta pages you list today */ MCP_AUDIT_PAGE],
```

`otta({ mcp: true })` declares both for you.

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

## Audit log

Otta keeps its own log of every Otta MCP tool call, reads included. It lives in the plugin's
storage, in the `mcp_audit` collection. EmDash also writes one row per call to its own
`audit_logs` (actor, IP, tool, success or failure). That row carries no parameters or Otta code,
and EmDash has no screen for it. Otta leaves it as it is.

### What is recorded

Each entry holds:

- `id`, a time-ordered id, and `at`, the time of the call (ISO, UTC).
- `actor`: the EmDash user the call ran as (`id`, `email`, `name`, `role`), as EmDash verified
  it. It is never read from the input. A call with no user is logged with `actor: null`.
- `ip` and `userAgent`, from EmDash's request metadata.
- `tool`: the bare name, such as `orders_refund`.
- `input`: the parameters as sent, redacted (see below). A serialized input over 8 KB is stored
  as `{truncated: true, bytes, preview}`: its byte length and its first 1,024 characters.
- `status`: `started`, `ok`, `refused`, `needs_confirmation` or `error`.
- `code`: the refusal code when `refused`, or `INTERNAL_ERROR` for an unexpected failure.
- `affected`: when there are any, the ids the call named or created (order, product, coupon id
  or code, zone, method, rate, tax class) and any `amountCents` and `currency` it sent (a
  refund's amount, for example).
- `finishedAt`.

The `started` entry is written before the tool runs. If it cannot be written, the call is refused
with `AUDIT_UNAVAILABLE` (HTTP 503 on the route) and the tool does not run, so no call goes
unlogged. The entry is updated once the tool has answered. If that update fails, the tool's answer
still goes back unchanged, because the action already happened. The entry then stays `started`,
which means "outcome unknown": check the order, coupon or setting itself.

A schema refusal through `/_emdash/api/mcp` (see [Errors](#errors)) comes from the MCP SDK
before the tool's route runs, so Otta never sees that call and does not log it. EmDash's own
row records it.

### Redaction

The two payment-secret tools (`payments_set_secret`, `payments_clear_secret`) are recorded as
their keys only, every value `"[redacted]"`. An unknown key sent to them is counted, never named.
No other tool takes a secret: every input field of the 47 tools was checked, and a test fails if a
secret-like field is ever added to a tool that is not redacted. Notes, reasons and other free text
are recorded as sent.

### Retention

Entries are kept for one year (365 days). Nothing else deletes one, and no tool edits or deletes
entries. After each logged call, up to 20 expired entries are deleted, oldest first. A failed
prune is a warning and never fails the call.

### Reading it

- **The `audit_list` tool**: read-only. Optional filters `tool`, `actorId`, `status`, `since`
  (inclusive) and `until` (exclusive, ISO instants), plus `limit` (1 to 100, default 50) and
  `cursor`. Newest first, with `nextCursor` when there is more. A cursor works only with the
  filters it came from.
- **The Audit log page** in the Otta admin (`/_emdash/admin/plugins/otta/mcp-audit`): a table of
  time, user email, tool, status and code, and a short input summary, with the same filters and
  paging. It is listed only on a site with the MCP tools on.

### One EmDash user per agent

EmDash passes a plugin the user a token belongs to, not the token itself. Two agents whose tokens
belong to the same user look the same in the log. To tell agents apart, give each agent its own
EmDash user (an Admin, since the tools need `plugins:manage`) and mint its token as that user.
