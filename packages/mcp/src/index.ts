// Public barrel of @urumi.ai/otta-mcp — the wrapper that adds admin MCP tools to
// the Otta plugin (`withMcp`), the tool table it reads by default, and the two
// helpers every tool is written with.
export {
	AUDIT_INPUT_MAX_BYTES,
	AUDIT_PRUNE_BATCH,
	AUDIT_RETENTION_DAYS,
	AUDIT_STATUSES,
	REDACTED,
	type AuditActor,
	type AuditAffected,
	type AuditEntry,
	type AuditStatus,
} from "./audit.js";
export { AUDIT_PAGE_ACTIONS, createAuditPageHandler } from "./audit-page.js";
export { ToolError, toolFailure } from "./errors.js";
export { defineTool, type McpToolDef } from "./tool.js";
export { OTTA_MCP_TOOLS } from "./tools/index.js";
export {
	MCP_ROUTE_PERMISSION,
	MCP_ROUTE_PREFIX,
	withMcp,
	type McpPlugin,
	type McpRouteEntry,
	type McpToolEntry,
} from "./with-mcp.js";
