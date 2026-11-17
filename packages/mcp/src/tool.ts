import type { AdminClients, PluginContext } from "@urumi.ai/otta-plugin";
import type { z } from "zod";

/**
 * One MCP tool: one entry in the tool table. `withMcp` turns it into a private
 * route `mcp/<name>` and the matching `mcp.tools` entry, so adding a tool is
 * adding one of these.
 */
export interface McpToolDef<I extends z.ZodTypeAny> {
	/** snake_case, unique; EmDash exposes it as `otta__<name>`. */
	name: string;
	/** For agents: what it does, when to use it, and units
	 *  ("minor units, e.g. 1999 = $19.99"). */
	description: string;
	/** Validated by the route before `run` sees anything. */
	input: I;
	/** Clients ask before running it (MCP `destructiveHint`). */
	destructive?: boolean;
	/**
	 * The work. Writes go through the plugin's admin operations, never straight to a
	 * surface write method. A refusal throws a `ToolError` (`toolFailure`); the
	 * return value is the tool's JSON result.
	 */
	run(args: {
		ctx: PluginContext;
		clients: AdminClients;
		input: z.infer<I>;
		/** Who the host says is signed in (display name, else email). */
		operator: string | undefined;
	}): Promise<unknown>;
}

/** Identity, for inference: `input`'s schema types `run`'s `input`. */
export function defineTool<I extends z.ZodTypeAny>(def: McpToolDef<I>): McpToolDef<I> {
	return def;
}
