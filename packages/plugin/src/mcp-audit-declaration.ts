/**
 * What the MCP add-on's audit log (`@urumi.ai/otta-mcp`, ADR-0046) needs the
 * deploying site's descriptor to declare: its storage collection and its admin
 * page. DATA ONLY: the writer, the `audit_list` tool and the page itself live in
 * `@urumi.ai/otta-mcp`.
 *
 * WHY THE DECLARATION IS HERE AND NOT IN THE ADD-ON. EmDash takes a plugin's
 * storage collections and admin pages from its DESCRIPTOR only
 * (`adaptSandboxEntry` reads `descriptor.storage` / `descriptor.adminPages`), and
 * the descriptor is built in `@urumi.ai/otta-store`, for which the add-on is an
 * OPTIONAL peer: it cannot import from a package a store may not have installed.
 * It already imports this package, so the declaration lives here, and the
 * descriptor adds it only when the site opts in to `mcp`. Without that opt-in the
 * collection is not declared and the page is not listed, so the plugin on its own
 * neither stores nor shows any of this.
 */
import type { AdminPageConfig } from "./types.js";
import type { CommerceStorageLayout } from "./commerce/commerce-storage.js";

/** The audit log's collection: one document per MCP tool call. */
export const MCP_AUDIT_COLLECTION = "mcp_audit";

/**
 * Its declaration. Each index is a field the log is read by: `at` (newest first,
 * the `since`/`until` range, and the retention prune), and the three filters.
 * Single-field indexes only: on D1 a new index costs a row write per stored
 * document on the day it is built, so the list stays as short as the reads allow.
 */
export const MCP_AUDIT_STORAGE_COLLECTIONS: CommerceStorageLayout = Object.freeze({
	[MCP_AUDIT_COLLECTION]: Object.freeze({
		indexes: Object.freeze(["at", "tool", "actorId", "status"]),
	}),
});

/** The "Audit log" admin page, served by the add-on through the plugin's `admin` route. */
export const MCP_AUDIT_PAGE: AdminPageConfig = {
	path: "/mcp-audit",
	label: "Audit log",
	icon: "list",
};
