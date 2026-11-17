/**
 * The Otta plugin with its admin MCP tools, for an IN-PROCESS registration: a
 * site opts in by pointing its Otta descriptor's `entrypoint` here instead of at
 * `@urumi.ai/otta-plugin/trusted`. Same plugin id, storage, capabilities and
 * allowed hosts; only the routes and the `mcp` block are added.
 */
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import { withMcp } from "./with-mcp.js";

export default withMcp(createOttaPlugin({ trustedHost: true }));
