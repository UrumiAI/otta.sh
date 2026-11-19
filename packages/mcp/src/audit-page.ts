/**
 * The "Audit log" admin page: the MCP audit log as a Block Kit table (time, user,
 * tool, status and code, an input summary) with the `audit_list` filters and
 * paging. Block Kit only, like every page of the standard-format Otta plugin.
 *
 * WHERE IT LIVES. EmDash renders every plugin admin page through the plugin's one
 * `admin` route (`page_load` / `block_action` / `form_submit`). `withMcp` wraps
 * that route: this page's interactions come here, every other interaction goes to
 * the plugin's own handler unchanged. So the page exists only where the add-on is
 * installed, and is listed in the nav only where the descriptor declares
 * `MCP_AUDIT_PAGE`, which `@urumi.ai/otta-store` does exactly when `mcp` is on.
 */
import {
	MCP_AUDIT_PAGE,
	type Block,
	type BlockResponse,
	type PluginContext,
	type RouteHandler,
	type SandboxedRouteContext,
} from "@urumi.ai/otta-plugin";
import {
	AUDIT_STATUSES,
	decodeAuditCursor,
	listAudit,
	normalizeInstant,
	type AuditEntry,
	type AuditFilters,
	type AuditStatus,
} from "./audit.js";
import { ToolError } from "./errors.js";

/** This page's action ids, namespaced so they cannot meet another screen's. */
export const AUDIT_PAGE_ACTIONS = {
	filter: "mcp-audit:filter",
	clear: "mcp-audit:clear",
	page: "mcp-audit:page",
} as const;

const ACTION_IDS: ReadonlySet<string> = new Set(Object.values(AUDIT_PAGE_ACTIONS));

/** Rows per page. */
export const AUDIT_PAGE_SIZE = 25;

/** The input summary's length in a table cell. */
const SUMMARY_MAX = 120;

const ANY = "__any__";

interface AuditPageInput {
	type?: unknown;
	page?: unknown;
	action_id?: unknown;
	values?: unknown;
	value?: unknown;
}

/** Whether an `admin` interaction belongs to this page. */
export function isAuditPageInteraction(input: unknown): boolean {
	const record = (input ?? {}) as AuditPageInput;
	if (typeof record.action_id === "string" && ACTION_IDS.has(record.action_id)) return true;
	return record.type === "page_load" && record.page === MCP_AUDIT_PAGE.path;
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** A bare day (`2026-11-01`) or an instant, as an instant; `until` of a day is that day's end. */
function boundOf(raw: string, end: boolean): string | undefined {
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		const start = normalizeInstant(`${raw}T00:00:00.000Z`);
		if (start === undefined) return undefined;
		return end ? new Date(Date.parse(start) + 86_400_000).toISOString() : start;
	}
	return normalizeInstant(raw);
}

/**
 * A bound as the form shows it: the inverse of {@link boundOf}, so what the
 * operator typed comes back as typed. A UTC midnight shows as its day; for
 * "Before" that is the day BEFORE it (typed `2026-11-19` is stored as the
 * exclusive `2026-11-20T00:00:00.000Z`). Anything else shows as the instant.
 */
function boundText(instant: string, end: boolean): string {
	if (!instant.endsWith("T00:00:00.000Z")) return instant;
	const ms = Date.parse(instant) - (end ? 86_400_000 : 0);
	return new Date(ms).toISOString().slice(0, 10);
}

/** The filters a filter form sent, or the problem with them. */
function filtersFromValues(
	values: unknown,
	tools: readonly string[],
): { filters: AuditFilters } | { problem: string; filters: AuditFilters } {
	const record = (typeof values === "object" && values !== null ? values : {}) as Record<
		string,
		unknown
	>;
	const filters: AuditFilters = {};
	const tool = text(record["tool"]);
	if (tool !== undefined && tool !== ANY && tools.includes(tool)) filters.tool = tool;
	const status = text(record["status"]);
	if (status !== undefined && (AUDIT_STATUSES as readonly string[]).includes(status)) {
		filters.status = status as AuditStatus;
	}
	const actorId = text(record["actorId"]);
	if (actorId !== undefined) filters.actorId = actorId.slice(0, 200);
	for (const key of ["since", "until"] as const) {
		const raw = text(record[key]);
		if (raw === undefined) continue;
		const bound = boundOf(raw, key === "until");
		if (bound === undefined) {
			return {
				filters,
				problem: `${key === "since" ? "From" : "Before"} is not a date (YYYY-MM-DD) or an ISO instant.`,
			};
		}
		filters[key] = bound;
	}
	return { filters };
}

/** `2026-11-19T10:03:04.120Z` as `2026-11-19 10:03:04 UTC`. */
function formatAt(at: string): string {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(at)
		? `${at.slice(0, 10)} ${at.slice(11, 19)} UTC`
		: at;
}

function statusCell(entry: AuditEntry): string {
	if (entry.status === "started") return "started (outcome unknown)";
	if (entry.status === "needs_confirmation") return "needs confirmation";
	return entry.code === undefined ? entry.status : `${entry.status}: ${entry.code}`;
}

/** The input as one short line of JSON. */
function inputSummary(input: unknown): string {
	if (input === null || input === undefined) return "";
	const json = JSON.stringify(input) ?? "";
	if (json === "{}") return "";
	return json.length > SUMMARY_MAX ? `${json.slice(0, SUMMARY_MAX - 1)}…` : json;
}

function filterForm(filters: AuditFilters, tools: readonly string[]): Block {
	return {
		type: "form",
		block_id: "mcp-audit:filters",
		fields: [
			{
				type: "select",
				action_id: "tool",
				label: "Tool",
				options: [
					{ value: ANY, label: "Any tool" },
					...tools.toSorted().map((name) => ({ value: name, label: name })),
				],
				initial_value: filters.tool ?? ANY,
			},
			{
				type: "select",
				action_id: "status",
				label: "Status",
				options: [
					{ value: ANY, label: "Any status" },
					...AUDIT_STATUSES.map((status) => ({ value: status, label: status })),
				],
				initial_value: filters.status ?? ANY,
			},
			{
				type: "text_input",
				action_id: "actorId",
				label: "User id",
				...(filters.actorId === undefined ? {} : { initial_value: filters.actorId }),
			},
			{
				type: "text_input",
				action_id: "since",
				label: "From (UTC)",
				placeholder: "YYYY-MM-DD or an ISO instant",
				...(filters.since === undefined ? {} : { initial_value: boundText(filters.since, false) }),
			},
			{
				type: "text_input",
				action_id: "until",
				label: "Before (UTC)",
				placeholder: "YYYY-MM-DD (that whole day) or an ISO instant",
				...(filters.until === undefined ? {} : { initial_value: boundText(filters.until, true) }),
			},
		],
		submit: { label: "Filter", action_id: AUDIT_PAGE_ACTIONS.filter },
	};
}

function filtered(filters: AuditFilters): boolean {
	return Object.keys(filters).length > 0;
}

async function render(
	ctx: PluginContext,
	tools: readonly string[],
	filters: AuditFilters,
	cursor: string | undefined,
	problem?: string,
): Promise<BlockResponse> {
	const blocks: Block[] = [
		{ type: "header", text: "Audit log" },
		{
			type: "context",
			text: "Every Otta MCP tool call, newest first. Secrets show as [redacted]. Kept for one year.",
		},
		filterForm(filters, tools),
	];
	if (filtered(filters)) {
		blocks.push({
			type: "actions",
			elements: [{ type: "button", action_id: AUDIT_PAGE_ACTIONS.clear, label: "Clear filters" }],
		});
	}
	if (problem !== undefined) {
		blocks.push({ type: "banner", variant: "error", title: problem });
		return { blocks };
	}
	let page;
	try {
		page = await listAudit(ctx, filters, AUDIT_PAGE_SIZE, cursor);
	} catch (error) {
		const title =
			error instanceof ToolError && error.code === "INVALID_CURSOR"
				? "That page is no longer available. Filter again to start from the newest."
				: "The audit log could not be read. Try again.";
		blocks.push({ type: "banner", variant: "error", title });
		return { blocks };
	}
	blocks.push({
		type: "table",
		block_id: "mcp-audit:list",
		columns: [
			{ key: "at", label: "Time" },
			{ key: "user", label: "User" },
			{ key: "tool", label: "Tool", format: "code" },
			{ key: "status", label: "Status" },
			{ key: "input", label: "Input" },
		],
		rows: page.entries.map((entry) => ({
			at: formatAt(entry.at),
			user: entry.actor?.email ?? entry.actor?.name ?? entry.actorId ?? "unknown",
			tool: entry.tool,
			status: statusCell(entry),
			input: inputSummary(entry.input),
		})),
		page_action_id: AUDIT_PAGE_ACTIONS.page,
		...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
		empty_text: filtered(filters)
			? "No tool calls match these filters."
			: "No MCP tool calls yet. They appear here once an agent calls an Otta tool.",
	});
	return { blocks };
}

/**
 * The page's handler, for the tool table `tools` (the Tool filter's choices).
 * A "Load more" carries its filters inside the cursor, so paging keeps them.
 */
export function createAuditPageHandler(tools: readonly string[]): RouteHandler {
	return async (routeCtx: SandboxedRouteContext, ctx: PluginContext) => {
		const input = (routeCtx.input ?? {}) as AuditPageInput;
		if (input.action_id === AUDIT_PAGE_ACTIONS.filter) {
			const parsed = filtersFromValues(input.values, tools);
			return render(
				ctx,
				tools,
				parsed.filters,
				undefined,
				"problem" in parsed ? parsed.problem : undefined,
			);
		}
		if (input.action_id === AUDIT_PAGE_ACTIONS.page) {
			const token = text((input.value as { cursor?: unknown } | undefined)?.cursor);
			const decoded = token === undefined ? undefined : decodeAuditCursor(token);
			if (decoded === undefined || token === undefined) return render(ctx, tools, {}, undefined);
			return render(ctx, tools, decoded.filters, token);
		}
		return render(ctx, tools, {}, undefined);
	};
}
