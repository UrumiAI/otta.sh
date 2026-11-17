// Public barrel of @urumi.ai/otta-mcp — the wrapper that adds admin MCP tools to
// the Otta plugin (`withMcp`), the tool table it reads by default, and the two
// helpers every tool is written with.
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
