import {
	appendOrderNote,
	idempotencyKey as toIdempotencyKey,
	legalNextStates,
	listOrderNotes,
	type OrderListCursor,
	type OrderListFilter,
	orderId as toOrderId,
	type OrderNote,
	type OrderNotesStore,
	type OrderState,
	type OrderStore,
	resolveReconciliation,
	transitionOrder,
} from "@urumi/domain";
import { Hono } from "hono";
import { z } from "zod";
import {
	appendNoteBody,
	orderListFilterSchema,
	orderPathParams,
	ordersListQuery,
	orderStateEnum,
	resolveReconciliationBody,
	transitionBody,
} from "../schemas.js";
import { serializeOrder, serializeOrderSummary } from "./orders.js";
import { requireInternalToken } from "./internal-auth.js";

export interface AdminRoutesDeps {
	orderStore: OrderStore;
	/** Append-only order notes (admin-UX Increment 0). */
	orderNotesStore: OrderNotesStore;
	/** Reuses the existing service privileged auth (X-Internal-Token). Phase 5
	 *  introduces no separate admin identity (Risk 7): the internal token is the
	 *  service's privileged mechanism; a real admin panel calls this with it. */
	internalToken?: string;
}

/**
 * Admin order-status transition (Phase 5 §7). The only customer-facing surface
 * that can move an order is NONE — this endpoint requires the privileged
 * (internal-token) auth. Legality is enforced in the domain (`transitionOrder`);
 * a transition that also has a template enqueues exactly one email atomically
 * with the flip (§5), drained by the dispatcher.
 */
export function adminRoutes(deps: AdminRoutesDeps): Hono {
	const app = new Hono();

	// -- Admin Orders console: view-only list + detail (internal-token guarded) --

	app.get("/orders", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const parsed = ordersListQuery.safeParse(c.req.query());
		if (!parsed.success)
			return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
		const q = parsed.data;

		let filter: OrderListFilter;
		let limit: number;
		let cursorPos: OrderListCursor | null;

		if (q.cursor !== undefined) {
			// Paged request: the opaque cursor carries the keyset POSITION plus the
			// active filter (so filters survive paging) plus the page limit. Decoding
			// MUST fail CLOSED to a 400 — a malformed/tampered/garbage token never
			// 500s (MOD-1). The decoded filter is RE-VALIDATED through zod and the
			// decoded limit RE-CLAMPED server-side (never trusted past max=100).
			const decoded = decodeCursor(q.cursor);
			if (decoded === null) return c.json({ error: "invalid cursor" }, 400);
			const filterParsed = orderListFilterSchema.safeParse(decoded.filter);
			const posParsed = cursorPosOf(decoded.pos);
			if (!filterParsed.success || posParsed === null) {
				return c.json({ error: "invalid cursor" }, 400);
			}
			filter = toFilter(filterParsed.data);
			cursorPos = posParsed;
			limit = clampLimit(decoded.limit, q.limit);
		} else {
			// First page: build the filter from the query string (CSV states →
			// per-token validated enum array), validate the assembled filter, and take
			// the already-clamped query limit.
			const built = buildFilterFromQuery(q.states, q.from, q.to, q.search);
			if (built === null) return c.json({ error: "invalid states filter" }, 400);
			filter = built;
			cursorPos = null;
			limit = q.limit;
		}

		const result = await deps.orderStore.listOrders(filter, { cursor: cursorPos, limit });
		const nextCursor =
			result.nextCursor === null ? null : encodeCursor(result.nextCursor, filter, limit);
		return c.json({ ok: true, orders: result.orders.map(serializeOrderSummary), nextCursor }, 200);
	});

	app.get("/orders/:orderId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const order = await deps.orderStore.getById(toOrderId(params.data.orderId));
		if (order === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		// The transition buttons the console renders come straight from the domain
		// state machine — the single source of truth (never a UI-side re-listing).
		return c.json(
			{
				ok: true,
				order: serializeOrder(order),
				allowedTransitions: [...legalNextStates(order.state)],
			},
			200,
		);
	});

	app.post("/orders/:orderId/transition", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = transitionBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:transition:${params.data.orderId}:${parsed.data.toState}`;
		const res = await transitionOrder(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				toState: parsed.data.toState,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json(
				{ ok: true, transitioned: res.transitioned, order: serializeOrder(res.order) },
				200,
			);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		return c.json({ ok: false, reason: res.reason }, 409); // INVALID_TRANSITION
	});

	// -- Admin Orders console: resolve a reconciliation flag (admin-UX Increment 1)
	// A NON-GET, so the app-level X-Service-Token write gate covers it when the
	// service secret is set; the route additionally requires the internal token.
	// Mirrors the port 1:1 — clears the flag + records the disposition, never
	// touching state/line items (the snapshot invariant lives in the domain).
	app.post("/orders/:orderId/resolve-reconciliation", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = resolveReconciliationBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// Idempotency (CLAUDE.md): the client `Idempotency-Key` header, or a stable
		// fallback derived from the order id (a header-less double-submit dedupes on
		// the guarded flip, not a fresh key each time).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:resolve-reconciliation:${params.data.orderId}`;
		const res = await resolveReconciliation(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				expectedFlag: parsed.data.expectedFlag,
				outcome: parsed.data.outcome,
				reason: parsed.data.reason,
				resolvedBy: parsed.data.resolvedBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json({ ok: true, resolved: res.resolved, order: serializeOrder(res.order) }, 200);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		// Reconciliation-axis conflicts (like an INVALID_TRANSITION) → 409:
		// NOT_IN_RECONCILIATION (never flagged) and RECONCILIATION_FLAG_CHANGED
		// (the live flag differs from the one the admin reviewed — reload and
		// re-review). The trimmed-empty guards → 400.
		if (res.reason === "NOT_IN_RECONCILIATION" || res.reason === "RECONCILIATION_FLAG_CHANGED")
			return c.json({ ok: false, reason: res.reason }, 409);
		return c.json({ ok: false, reason: res.reason }, 400); // EMPTY_REASON / EMPTY_RESOLVER
	});

	// -- Admin Orders console: append-only order notes (admin-UX Increment 0) ----
	// GET is internal-token guarded (a read); POST is additionally covered by the
	// app-level X-Service-Token write gate (any non-GET) when the service secret is
	// set — no per-route gate is needed here.

	app.get("/orders/:orderId/notes", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const notes = await listOrderNotes(
			{ orderNotesStore: deps.orderNotesStore },
			toOrderId(params.data.orderId),
		);
		return c.json({ ok: true, notes: notes.map(serializeNote) }, 200);
	});

	app.post("/orders/:orderId/notes", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = appendNoteBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// Idempotency (CLAUDE.md): the client `Idempotency-Key` header, or a fallback
		// derived from the order id (so a header-less double-submit still dedupes on
		// a stable key rather than always inserting).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:note:${params.data.orderId}:${parsed.data.author}:${parsed.data.body}`;
		const res = await appendOrderNote(
			{ orderNotesStore: deps.orderNotesStore, orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				author: parsed.data.author,
				body: parsed.data.body,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json({ ok: true, appended: res.appended, note: serializeNote(res.note) }, 201);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		return c.json({ ok: false, reason: res.reason }, 400); // EMPTY_AUTHOR / EMPTY_BODY
	});

	return app;
}

/** Wire shape of an order note (admin-UX Increment 0). Plain annotation — no
 *  money, no branded ids leaked beyond the string id. */
function serializeNote(note: OrderNote): Record<string, unknown> {
	return {
		id: note.id,
		orderId: note.orderId,
		author: note.author,
		body: note.body,
		createdAt: note.createdAt,
	};
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** Clamp a page limit into [1, 100] (MOD-1: a decoded cursor's limit is
 *  RE-CLAMPED, never honored past the max). Falls back to the query limit, then
 *  the default, for a missing/garbage value. */
function clampLimit(decoded: unknown, queryLimit: number): number {
	const raw =
		typeof decoded === "number" && Number.isFinite(decoded)
			? decoded
			: Number.isFinite(queryLimit)
				? queryLimit
				: DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

/** Build a domain filter from raw query params. CSV `states` are split and each
 *  token validated against the shared enum — an unknown token ⇒ null (→ 400). */
function buildFilterFromQuery(
	states: string | undefined,
	from: string | undefined,
	to: string | undefined,
	search: string | undefined,
): OrderListFilter | null {
	const filter: OrderListFilter = {};
	if (states !== undefined) {
		const tokens = states
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const parsed: OrderState[] = [];
		for (const t of tokens) {
			const r = orderStateEnum.safeParse(t);
			if (!r.success) return null;
			parsed.push(r.data);
		}
		if (parsed.length > 0) filter.states = parsed;
	}
	if (from !== undefined) filter.from = from;
	if (to !== undefined) filter.to = to;
	if (search !== undefined) filter.search = search;
	return filter;
}

/** Narrow a validated-filter zod result back into the domain `OrderListFilter`
 *  (drops `undefined` keys so the shape is exact). */
function toFilter(parsed: {
	states?: OrderState[];
	from?: string;
	to?: string;
	search?: string;
}): OrderListFilter {
	const filter: OrderListFilter = {};
	if (parsed.states !== undefined && parsed.states.length > 0) filter.states = parsed.states;
	if (parsed.from !== undefined) filter.from = parsed.from;
	if (parsed.to !== undefined) filter.to = parsed.to;
	if (parsed.search !== undefined) filter.search = parsed.search;
	return filter;
}

/** The decoded cursor's `createdAt` must be a valid ISO-8601 datetime — the SAME
 *  check the query `from`/`to` bounds use — so a tampered/garbage position is a
 *  malformed cursor (→ 400), never a raw string that reaches the store's keyset
 *  comparison. */
const cursorCreatedAt = z.string().datetime();

/** Validate a decoded cursor position shape — `{ createdAt: <ISO datetime>, id:
 *  <opaque, bounded string> }` — or null if malformed (→ 400). */
function cursorPosOf(pos: unknown): OrderListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; id?: unknown };
	if (typeof p.createdAt !== "string" || !cursorCreatedAt.safeParse(p.createdAt).success) {
		return null;
	}
	if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 200) return null;
	return { createdAt: p.createdAt, id: toOrderId(p.id) };
}

interface DecodedCursor {
	pos: unknown;
	filter: unknown;
	limit: unknown;
}

/** Encode the keyset position + active filter + limit into an opaque base64url
 *  token, so paging preserves the filter and clamped limit. */
function encodeCursor(pos: OrderListCursor, filter: OrderListFilter, limit: number): string {
	const payload = { pos: { createdAt: pos.createdAt, id: pos.id }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode an opaque cursor token; returns null on ANY malformed/garbage input so
 *  the route answers 400 rather than 500 (MOD-1). */
function decodeCursor(token: string): DecodedCursor | null {
	try {
		const json = new TextDecoder().decode(fromBase64Url(token));
		const parsed = JSON.parse(json) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const p = parsed as DecodedCursor;
		return { pos: p.pos, filter: p.filter, limit: p.limit };
	} catch {
		return null;
	}
}

// Portable base64url (Node + workerd both provide btoa/atob + TextEncoder).
function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64); // throws on invalid base64 ⇒ caught by decodeCursor ⇒ 400
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
