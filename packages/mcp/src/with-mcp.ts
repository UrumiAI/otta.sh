import {
	makeAdminClients,
	operatorName,
	type RouteEntry,
	type RouteHandler,
	type SandboxedPlugin,
} from "@urumi.ai/otta-plugin";
import type { z } from "zod";
import { toolFailure } from "./errors.js";
import type { McpToolDef } from "./tool.js";
import { OTTA_MCP_TOOLS } from "./tools/index.js";

/** Every tool's route is `mcp/<name>`, beside the plugin's own routes. */
export const MCP_ROUTE_PREFIX = "mcp/";

/**
 * Admin only — what the Otta admin screens need today (the `admin` route
 * declares no permission, so EmDash falls back to this one). Editors gain nothing.
 */
export const MCP_ROUTE_PERMISSION = "plugins:manage";

/** EmDash's MCP tool-name pattern is `[a-zA-Z0-9_-]`; the table is stricter. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A tool's route. EmDash registers a plugin MCP tool only when its route is
 * private, not `raw`, a JSON POST contract (`isJsonPostRouteContract`:
 * `methods` includes POST, `request.body` is "json") and declares a `permission`
 * EmDash knows (`getPluginMcpTools` in `emdash-runtime.ts`). Anything less and
 * the tool is dropped without a word, so every field here is fixed.
 */
export interface McpRouteEntry {
	handler: RouteHandler;
	public: false;
	permission: typeof MCP_ROUTE_PERMISSION;
	methods: ["POST"];
	request: { body: "json" };
}

/** The `mcp.tools` entry EmDash reads (`PluginMcpToolDefinition`). */
export interface McpToolEntry {
	description: string;
	route: string;
	input: z.ZodTypeAny;
	destructive: boolean;
}

/** The plugin, plus its tool routes and the `mcp` block. Still a `SandboxedPlugin`. */
export interface McpPlugin extends SandboxedPlugin {
	routes: Record<string, RouteEntry>;
	mcp: { tools: Record<string, McpToolEntry> };
}

/**
 * An issue's message with nothing the caller sent in it: its kind, said
 * generically. For a {@link McpToolDef.sensitiveInput} tool, whose zod messages
 * could carry part of the input (an unknown key is named in its message).
 */
function redactedMessage(issue: z.ZodError["issues"][number]): string {
	switch (issue.code) {
		case "invalid_type":
			return `expected ${issue.expected}`;
		case "unrecognized_keys":
			return "unknown key (not echoed); send only the documented fields";
		case "invalid_value":
			return "not one of the allowed values";
		default:
			return `invalid (${issue.code})`;
	}
}

function describeIssues(
	error: z.ZodError,
	sensitive: boolean,
): {
	message: string;
	issues: { path: string; message: string }[];
} {
	const issues = error.issues.map((issue) => ({
		// A path is made of the schema's own keys (a strict object reports an
		// unknown key at its parent's path, never its own name).
		path: issue.path.map(String).join("."),
		message: sensitive ? redactedMessage(issue) : issue.message,
	}));
	const message = issues
		.map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
		.join("; ");
	return { message: `Invalid input: ${message}`, issues };
}

function toolRoute(def: McpToolDef<z.ZodTypeAny>): McpRouteEntry {
	return {
		public: false,
		permission: MCP_ROUTE_PERMISSION,
		methods: ["POST"],
		request: { body: "json" },
		async handler(routeCtx, ctx) {
			const parsed = def.input.safeParse(routeCtx.input);
			if (!parsed.success) {
				const { message, issues } = describeIssues(parsed.error, def.sensitiveInput === true);
				toolFailure("INVALID_INPUT", message, { issues });
			}
			const clients = await makeAdminClients(ctx);
			return def.run({
				ctx,
				clients,
				input: parsed.data,
				operator: operatorName(routeCtx.user),
			});
		},
	};
}

/**
 * The plugin with the tool table added: per tool, a route `mcp/<name>` and an
 * `mcp.tools[<name>]` entry, under the plugin's own id (its storage is private to
 * that id, so the tools have to run inside it).
 *
 * Returns a NEW object; `plugin` is not touched. Throws when a tool's route
 * would replace an existing route, when two tools share a name, or when a name
 * is not snake_case: a tool table mistake fails at startup, not on first call.
 */
export function withMcp(
	plugin: SandboxedPlugin,
	tools: readonly McpToolDef<z.ZodTypeAny>[] = OTTA_MCP_TOOLS,
): McpPlugin {
	const routes: Record<string, RouteEntry> = { ...plugin.routes };
	const existing = (plugin as { mcp?: { tools?: Record<string, McpToolEntry> } }).mcp?.tools;
	const mcpTools: Record<string, McpToolEntry> = { ...existing };

	for (const def of tools) {
		if (!TOOL_NAME.test(def.name)) {
			throw new Error(`MCP tool name "${def.name}" must be snake_case (a-z, 0-9, _).`);
		}
		const routeName = `${MCP_ROUTE_PREFIX}${def.name}`;
		if (Object.hasOwn(routes, routeName)) {
			throw new Error(`MCP tool "${def.name}" collides with the existing route "${routeName}".`);
		}
		if (Object.hasOwn(mcpTools, def.name)) {
			throw new Error(`MCP tool "${def.name}" is declared more than once.`);
		}
		routes[routeName] = toolRoute(def);
		mcpTools[def.name] = {
			description: def.description,
			route: routeName,
			input: def.input,
			destructive: def.destructive ?? false,
		};
	}

	return { ...plugin, routes, mcp: { tools: mcpTools } };
}
