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
 * Its declaration: ONE index, `at`. It serves every read the log makes: newest
 * first, the `since`/`until` range, and the retention prune (`at` < cutoff).
 * The other filters (`tool`, `actorId`, `status`) are applied in memory over a
 * bounded `at`-ordered scan (`@urumi.ai/otta-mcp`'s `listAudit`).
 *
 * WHY ONLY ONE. EmDash 1.5 builds a non-unique plugin index over EVERY
 * `_plugin_storage` row (no partial predicate: `plugin_id, collection,
 * json_extract(...)`), Otta's commerce rows and other plugins' included. So each
 * index costs about one D1 row write per stored row on the day it is built, and
 * one more index entry on every later plugin-storage write, commerce writes
 * included. The cron's index-build-day guard counts it (`INDEX_LAYOUT`).
 */
export const MCP_AUDIT_STORAGE_COLLECTIONS: CommerceStorageLayout = Object.freeze({
	[MCP_AUDIT_COLLECTION]: Object.freeze({
		indexes: Object.freeze(["at"]),
	}),
});

/** The "Audit log" admin page, served by the add-on through the plugin's `admin` route. */
export const MCP_AUDIT_PAGE: AdminPageConfig = {
	path: "/mcp-audit",
	label: "Audit log",
	icon: "list",
};
