# @urumi.ai/otta-mcp

Admin MCP tools for [Otta](https://github.com/UrumiAI/otta.sh). It lets a store admin or developer
run an Otta store from an AI agent (Claude Code, Claude Desktop) over the MCP endpoint EmDash
already serves at `/_emdash/api/mcp`.

There is no new server, transport or login. The package wraps the Otta plugin: `withMcp(plugin)`
adds one private route per tool and the matching `mcp.tools` entry, under the plugin's own id
(`otta`). EmDash exposes each tool as `otta__<name>`.

## Opting in

Point the site's Otta descriptor at this package's entrypoint instead of the plugin's:

```ts
entrypoint: "@urumi.ai/otta-mcp/trusted", // was "@urumi.ai/otta-plugin/trusted"
```

Nothing else in the descriptor changes. Then, in the EmDash admin, enable MCP tools for Otta and
consent to the tool list. A scoped API token also needs the scope `mcp:tools:otta`.

## Who can call the tools

Every tool needs the `plugins:manage` permission (Admin), the same as the Otta admin screens.
Writes go through the same guarded admin operations the admin uses, so idempotency, the refund
ledger and the confirm steps hold for an agent too.

## Errors

A refused call is an MCP tool error whose `_meta.code` is a stable code (for example
`INVALID_INPUT` or `NOT_FOUND`). Money is always integer minor units plus a currency.
