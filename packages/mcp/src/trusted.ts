/**
 * The Otta plugin with its admin MCP tools, for an IN-PROCESS registration: a
 * site opts in by pointing its Otta descriptor's `entrypoint` here instead of at
 * `@urumi.ai/otta-plugin/trusted`, and declaring the audit log's collection and
 * page (`MCP_AUDIT_STORAGE_COLLECTIONS`, `MCP_AUDIT_PAGE`). Same plugin id,
 * capabilities and allowed hosts; the tool routes and the `mcp` block are added,
 * and the `admin` route also serves the Audit log page.
 */
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import { withMcp } from "./with-mcp.js";

export default withMcp(createOttaPlugin({ trustedHost: true }));
