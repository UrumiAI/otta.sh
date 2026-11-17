import type { z } from "zod";
import type { McpToolDef } from "../tool.js";

/**
 * The tool table: every Otta MCP tool, one entry each. `withMcp` reads it by
 * default. Each area's tools live in their own module beside this one and are
 * spread in here.
 */
export const OTTA_MCP_TOOLS: readonly McpToolDef<z.ZodTypeAny>[] = [];
