/**
 * The MCP audit log: one document per tool call in the plugin's own storage
 * (`mcp_audit`, declared by the site's descriptor when it opts in to `mcp`), so an
 * operator can see who called which tool, with what, and what came of it.
 *
 * EmDash writes its own `audit_logs` row per plugin MCP call (`plugin_tool_invoke`:
 * actor, IP, tool, success or failure). That row has no parameters, no Otta
 * outcome code and no screen to read it, and it is left exactly as it is. This
 * log is Otta's, written by `withMcp` around every tool route.
 *
 * THE ORDER IS THE GUARANTEE. The `started` entry is written BEFORE the tool's
 * handler runs; if that write fails, the call is refused (`AUDIT_UNAVAILABLE`) and
 * nothing runs, so no tool call happens unlogged. The final update happens after
 * the handler, and its failure changes nothing about the call (the action already
 * happened): the entry stays `started`, which reads "outcome unknown".
 *
 * NOTHING SECRET IS STORED. A `sensitiveInput` tool's input is recorded as its
 * keys only, every value `"[redacted]"`. The actor comes from `routeCtx.user`,
 * which EmDash verified, never from input.
 */
import {
	MCP_AUDIT_COLLECTION,
	type PluginContext,
	type RouteCaller,
	type SandboxedRouteContext,
} from "@urumi.ai/otta-plugin";
import type { z } from "zod";
import { ToolError, toolFailure } from "./errors.js";
import type { McpToolDef } from "./tool.js";

/** Every status an entry can hold. `started` that never moved means "outcome unknown". */
export const AUDIT_STATUSES = ["started", "ok", "refused", "needs_confirmation", "error"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** Entries older than this are deleted; nothing else deletes one. */
export const AUDIT_RETENTION_DAYS = 365;
/** At most this many expired entries are deleted per tool call. */
export const AUDIT_PRUNE_BATCH = 20;
/** The serialized input is kept whole up to this many UTF-8 bytes. */
export const AUDIT_INPUT_MAX_BYTES = 8 * 1024;
/** How much of an over-cap input is kept, in characters of its JSON. */
export const AUDIT_INPUT_PREVIEW_CHARS = 1024;
/** What every value of a `sensitiveInput` tool's input is recorded as. */
export const REDACTED = "[redacted]";
/** The code of an unknown throw, as EmDash reports it to the agent. */
export const INTERNAL_ERROR = "INTERNAL_ERROR";

const DAY_MS = 86_400_000;
/** A user agent is caller text of any length; this much is enough to recognise one. */
const USER_AGENT_MAX = 512;

/** Who EmDash says made the call. */
export interface AuditActor {
	id: string | null;
	email: string | null;
	name: string | null;
	role: string | number | null;
}

/** An input too large to keep whole. */
export interface TruncatedInput {
	truncated: true;
	/** The UTF-8 byte length of the whole serialized input. */
	bytes: number;
	/** The start of the serialized input. */
	preview: string;
}

/** Ids and amounts the call touched, taken from its input and result. */
export type AuditAffected = Record<string, string | number>;

export interface AuditEntry {
	/** Time-ordered: sorts as the calls were made (within one isolate, exactly). */
	id: string;
	/** ISO-8601 UTC, when the call reached the tool route. */
	at: string;
	actor: AuditActor | null;
	/** `actor.id`, flat, so the log can be filtered by it (an index is a field). */
	actorId: string | null;
	ip: string | null;
	userAgent: string | null;
	/** The bare tool name, e.g. `orders_refund`. */
	tool: string;
	/** What the caller sent, redacted and capped. */
	input: unknown;
	status: AuditStatus;
	/** The refusal's code (`refused`), or `INTERNAL_ERROR` (`error`). */
	code?: string;
	affected?: AuditAffected;
	finishedAt?: string;
}

/** The audit collection, or a throw: an undeclared collection is an unusable log. */
function auditCollection(ctx: PluginContext) {
	const collection = ctx.storage?.[MCP_AUDIT_COLLECTION];
	if (collection === undefined) {
		throw new Error(`storage collection '${MCP_AUDIT_COLLECTION}' is not declared`);
	}
	return collection;
}

let sequence = 0;

/**
 * A sortable id: the time in base 36, fixed width, then a per-isolate sequence
 * (two calls in the same millisecond keep their order), then randomness (two
 * isolates never collide).
 */
export function newAuditId(nowMs: number): string {
	sequence = (sequence + 1) % 36 ** 4;
	const time = nowMs.toString(36).padStart(9, "0");
	const seq = sequence.toString(36).padStart(4, "0");
	const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
	return `${time}-${seq}-${random}`;
}

function textOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function actorOf(user: RouteCaller | undefined): AuditActor | null {
	if (user === undefined) return null;
	const role = user.role;
	return {
		id: textOrNull(user.id),
		email: textOrNull(user.email),
		name: textOrNull(user.name),
		role: typeof role === "string" || typeof role === "number" ? role : null,
	};
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** At most `max` UTF-16 units of `text`, never splitting a surrogate pair. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

/**
 * A `sensitiveInput` tool's input as recorded: its keys, every value
 * `"[redacted]"`. Only the schema's own keys are named, since an unknown key's
 * NAME is caller text too (a pasted secret could be one); unknown keys are
 * counted, not named. Anything that is not an object records as one marker.
 */
function redactedInput(def: McpToolDef<z.ZodTypeAny>, raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return REDACTED;
	const shape = (def.input as { def?: { shape?: Record<string, unknown> } }).def?.shape ?? {};
	const out: Record<string, unknown> = {};
	let unknown = 0;
	for (const key of Object.keys(raw)) {
		if (Object.hasOwn(shape, key)) out[key] = REDACTED;
		else unknown += 1;
	}
	if (unknown > 0) out["[unrecognized keys]"] = unknown;
	return out;
}

/** The input as recorded: redacted for a sensitive tool, and capped at 8 KB. */
export function auditInput(def: McpToolDef<z.ZodTypeAny>, raw: unknown): unknown {
	const recorded = def.sensitiveInput === true ? redactedInput(def, raw) : raw;
	if (recorded === undefined) return null;
	const text = JSON.stringify(recorded) ?? "null";
	const bytes = byteLength(text);
	if (bytes <= AUDIT_INPUT_MAX_BYTES) return recorded;
	const truncated: TruncatedInput = {
		truncated: true,
		bytes,
		preview: clip(text, AUDIT_INPUT_PREVIEW_CHARS),
	};
	return truncated;
}

/**
 * Write the `started` entry. Refuses the call with `AUDIT_UNAVAILABLE` when the
 * write fails: the caller must not run the tool then.
 */
export async function beginAudit(
	ctx: PluginContext,
	routeCtx: SandboxedRouteContext,
	def: McpToolDef<z.ZodTypeAny>,
	nowMs: number = Date.now(),
): Promise<AuditEntry> {
	const actor = actorOf(routeCtx.user);
	const userAgent = textOrNull(routeCtx.requestMeta?.userAgent);
	const entry: AuditEntry = {
		id: newAuditId(nowMs),
		at: new Date(nowMs).toISOString(),
		actor,
		actorId: actor?.id ?? null,
		ip: textOrNull(routeCtx.requestMeta?.ip),
		userAgent: userAgent === null ? null : clip(userAgent, USER_AGENT_MAX),
		tool: def.name,
		input: auditInput(def, routeCtx.input),
		status: "started",
	};
	try {
		await auditCollection(ctx).put(entry.id, entry);
	} catch {
		// No parameters in the warning, and none in the refusal.
		console.warn(`[otta-mcp] audit log unavailable; refused ${def.name} without running it.`);
		toolFailure(
			"AUDIT_UNAVAILABLE",
			"The audit log could not be written, so the tool did not run. Nothing was changed; try again later.",
		);
	}
	return entry;
}

/** How a call ended, as the audit records it. */
export type AuditOutcome =
	| { kind: "returned"; result: unknown }
	| { kind: "threw"; error: unknown };

/** A route error EmDash recognises by shape (`isPluginRouteError`), ours or not. */
function routeErrorCode(error: unknown): string | undefined {
	if (error instanceof ToolError) return error.code;
	if (
		error instanceof Error &&
		error.name === "PluginRouteError" &&
		typeof (error as { code?: unknown }).code === "string"
	) {
		return (error as unknown as { code: string }).code;
	}
	return undefined;
}

function finalStatus(outcome: AuditOutcome): { status: AuditStatus; code?: string } {
	if (outcome.kind === "returned") {
		const status = (outcome.result as { status?: unknown } | null | undefined)?.status;
		return { status: status === "needs_confirmation" ? "needs_confirmation" : "ok" };
	}
	const code = routeErrorCode(outcome.error);
	// An unknown throw reaches the agent as INTERNAL_ERROR (EmDash's own answer),
	// and so does a ToolError raised as one (`unhandled`): both are errors, not refusals.
	if (code === undefined || code === INTERNAL_ERROR) {
		return { status: "error", code: INTERNAL_ERROR };
	}
	return { status: "refused", code };
}

/** The input keys that name what a call touched. */
const AFFECTED_INPUT_KEYS = [
	"orderId",
	"productId",
	"couponId",
	"code",
	"zoneId",
	"methodId",
	"rateId",
	"classId",
	"taxClassId",
	"id",
	"amountCents",
	"currency",
] as const;

/** Result objects whose `id` names what a create (or update) touched. */
const AFFECTED_RESULT_OBJECTS = ["coupon", "zone", "method", "taxClass", "taxRate"] as const;

/**
 * What the call touched: the ids (and a refund's or rate's amount and currency)
 * in its input, plus the id of what a create made. Nothing from a sensitive
 * tool's input, whose every value is redacted. Small by construction: scalars
 * only, from a fixed list of keys.
 */
export function affectedOf(
	def: McpToolDef<z.ZodTypeAny>,
	input: unknown,
	outcome: AuditOutcome,
): AuditAffected | undefined {
	const affected: AuditAffected = {};
	if (
		def.sensitiveInput !== true &&
		typeof input === "object" &&
		input !== null &&
		!Array.isArray(input)
	) {
		const record = input as Record<string, unknown>;
		for (const key of AFFECTED_INPUT_KEYS) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0 && value.length <= 200) {
				affected[key] = value;
			} else if (typeof value === "number" && Number.isSafeInteger(value)) {
				affected[key] = value;
			}
		}
	}
	if (
		outcome.kind === "returned" &&
		typeof outcome.result === "object" &&
		outcome.result !== null
	) {
		const result = outcome.result as Record<string, unknown>;
		for (const key of AFFECTED_RESULT_OBJECTS) {
			const id = (result[key] as { id?: unknown } | null | undefined)?.id;
			if (typeof id === "string" && id.length > 0 && id.length <= 200) affected[`${key}Id`] = id;
		}
	}
	return Object.keys(affected).length > 0 ? affected : undefined;
}

/**
 * Record how the call ended. Never throws: a failure is a warning naming the
 * entry (and nothing the caller sent), and the entry stays `started`.
 */
export async function finishAudit(
	ctx: PluginContext,
	entry: AuditEntry,
	def: McpToolDef<z.ZodTypeAny>,
	input: unknown,
	outcome: AuditOutcome,
	nowMs: number = Date.now(),
): Promise<void> {
	const { status, code } = finalStatus(outcome);
	const affected = affectedOf(def, input, outcome);
	const finished: AuditEntry = {
		...entry,
		status,
		...(code === undefined ? {} : { code }),
		...(affected === undefined ? {} : { affected }),
		finishedAt: new Date(nowMs).toISOString(),
	};
	try {
		await auditCollection(ctx).put(entry.id, finished);
	} catch {
		console.warn(
			`[otta-mcp] audit entry ${entry.id} could not be finished; it stays "started" (outcome unknown).`,
		);
	}
}

/**
 * Delete up to {@link AUDIT_PRUNE_BATCH} entries older than the retention, oldest
 * first, by the `at` index. Never throws: a failure is a warning, and the next
 * call tries again. Returns how many were deleted.
 */
export async function pruneAudit(ctx: PluginContext, nowMs: number = Date.now()): Promise<number> {
	try {
		const collection = auditCollection(ctx);
		const cutoff = new Date(nowMs - AUDIT_RETENTION_DAYS * DAY_MS).toISOString();
		const page = await collection.query({
			where: { at: { lt: cutoff } },
			orderBy: { at: "asc" },
			limit: AUDIT_PRUNE_BATCH,
		});
		let deleted = 0;
		for (const item of page.items.slice(0, AUDIT_PRUNE_BATCH)) {
			if (await collection.delete(item.id)) deleted += 1;
		}
		return deleted;
	} catch {
		console.warn("[otta-mcp] audit log prune failed; it is retried on the next call.");
		return 0;
	}
}

/** What the log can be filtered by. `since` is inclusive, `until` exclusive. */
export interface AuditFilters {
	tool?: string;
	actorId?: string;
	status?: AuditStatus;
	since?: string;
	until?: string;
}

export interface AuditPage {
	entries: AuditEntry[];
	nextCursor?: string;
}

/** The filters in one canonical form, so a cursor can be checked against them. */
function filterKey(filters: AuditFilters): string {
	return JSON.stringify([
		filters.tool ?? null,
		filters.actorId ?? null,
		filters.status ?? null,
		filters.since ?? null,
		filters.until ?? null,
	]);
}

function base64urlEncode(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(token: string): string {
	const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
	return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** A cursor: the host's own, bound to the filters it was issued for. */
interface CursorBody {
	v: 1;
	f: AuditFilters;
	c: string;
}

export function encodeAuditCursor(filters: AuditFilters, hostCursor: string): string {
	const body: CursorBody = { v: 1, f: filters, c: hostCursor };
	return base64urlEncode(JSON.stringify(body));
}

/** The filters and host cursor a cursor carries, or `undefined` when it is not one. */
export function decodeAuditCursor(
	token: string,
): { filters: AuditFilters; hostCursor: string } | undefined {
	try {
		const body = JSON.parse(base64urlDecode(token)) as Partial<CursorBody>;
		if (body.v !== 1 || typeof body.c !== "string" || typeof body.f !== "object" || !body.f) {
			return undefined;
		}
		const f = body.f as Record<string, unknown>;
		const filters: AuditFilters = {};
		for (const key of ["tool", "actorId", "since", "until"] as const) {
			const value = f[key];
			if (value === undefined) continue;
			if (typeof value !== "string") return undefined;
			filters[key] = value;
		}
		if (f["status"] !== undefined) {
			if (!(AUDIT_STATUSES as readonly unknown[]).includes(f["status"])) return undefined;
			filters.status = f["status"] as AuditStatus;
		}
		return { filters, hostCursor: body.c };
	} catch {
		return undefined;
	}
}

/** An instant as the log stores it (`toISOString`), or `undefined` when it is not one. */
export function normalizeInstant(value: string): string | undefined {
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * One page of the log, newest first. A cursor must come from the same filters
 * (else `INVALID_CURSOR`); `since`/`until` must already be normalized.
 */
export async function listAudit(
	ctx: PluginContext,
	filters: AuditFilters,
	limit: number,
	cursor?: string,
): Promise<AuditPage> {
	let hostCursor: string | undefined;
	if (cursor !== undefined) {
		const decoded = decodeAuditCursor(cursor);
		if (decoded === undefined || filterKey(decoded.filters) !== filterKey(filters)) {
			toolFailure(
				"INVALID_CURSOR",
				"That cursor does not belong to these filters (or is not a cursor). Start again without `cursor`.",
			);
		}
		hostCursor = decoded.hostCursor;
	}
	const where: Record<string, string | { gte?: string; lt?: string }> = {};
	if (filters.tool !== undefined) where["tool"] = filters.tool;
	if (filters.actorId !== undefined) where["actorId"] = filters.actorId;
	if (filters.status !== undefined) where["status"] = filters.status;
	if (filters.since !== undefined || filters.until !== undefined) {
		where["at"] = {
			...(filters.since === undefined ? {} : { gte: filters.since }),
			...(filters.until === undefined ? {} : { lt: filters.until }),
		};
	}
	let page;
	try {
		page = await auditCollection(ctx).query({
			where,
			orderBy: { at: "desc" },
			limit,
			...(hostCursor === undefined ? {} : { cursor: hostCursor }),
		});
	} catch (error) {
		// The host refuses a cursor whose row is gone (pruned since it was issued).
		if (hostCursor !== undefined && error instanceof Error && /cursor/i.test(error.name)) {
			toolFailure("INVALID_CURSOR", "That cursor has expired. Start again without `cursor`.");
		}
		throw error;
	}
	return {
		entries: page.items.map((item) => item.data as AuditEntry),
		...(page.hasMore && page.cursor !== undefined
			? { nextCursor: encodeAuditCursor(filters, page.cursor) }
			: {}),
	};
}
