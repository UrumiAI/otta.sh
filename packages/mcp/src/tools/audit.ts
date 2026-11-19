/**
 * `audit_list`: read the MCP audit log. Read-only; no tool edits or deletes an
 * entry (only the one-year retention does).
 */
import { z } from "zod";
import { AUDIT_STATUSES, listAudit, normalizeInstant, type AuditFilters } from "../audit.js";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { cursorInput, instantInput } from "./common.js";

export const AUDIT_TOOLS = [
	defineTool({
		name: "audit_list",
		description:
			'Read the audit log of Otta MCP tool calls, newest first: who called which tool (the EmDash user the API token belongs to), with what input (secrets recorded as "[redacted]"), and how it ended. Each entry: {id, at, actor: {id, email, name, role} | null, ip, userAgent, tool, input, status, code?, affected?, finishedAt?}. status is started (the outcome is unknown: the tool may or may not have acted), ok, refused (code is the refusal code), needs_confirmation, or error (code INTERNAL_ERROR). Filters combine; since is inclusive, until exclusive. Returns `{entries, nextCursor?}`; with tool/actorId/status filters a page reads at most 500 entries, so it can come back short or even empty with a nextCursor: keep following nextCursor until there is none. Entries are kept for one year. Refusals: INVALID_INPUT (a since/until that is not an instant), INVALID_CURSOR.',
		input: z
			.object({
				tool: z.string().min(1).max(64).optional().describe("Only this tool, e.g. orders_refund."),
				actorId: z.string().min(1).max(200).optional().describe("Only calls by this user id."),
				status: z.enum(AUDIT_STATUSES).optional().describe("Only calls that ended this way."),
				since: instantInput("Only calls at or after this time,").optional(),
				until: instantInput("Only calls before this time,").optional(),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(50)
					.describe("How many entries to return, 1-100 (default 50)."),
				cursor: cursorInput,
			})
			.strict(),
		async run({ ctx, input }) {
			const filters: AuditFilters = {};
			if (input.tool !== undefined) filters.tool = input.tool;
			if (input.actorId !== undefined) filters.actorId = input.actorId;
			if (input.status !== undefined) filters.status = input.status;
			for (const key of ["since", "until"] as const) {
				const raw = input[key];
				if (raw === undefined) continue;
				const instant = normalizeInstant(raw);
				if (instant === undefined) {
					return toolFailure("INVALID_INPUT", `${key} is not an ISO-8601 instant.`, {
						field: key,
					});
				}
				filters[key] = instant;
			}
			return listAudit(ctx, filters, input.limit, input.cursor);
		},
	}),
];
