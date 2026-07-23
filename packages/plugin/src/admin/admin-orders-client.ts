import type { HttpAccess } from "../types.js";

/**
 * A tiny `ctx.http`-only client for the admin Orders console service surface
 * (view-only list + detail, plus the existing status transition). Same transport
 * discipline as `ReportingSettingsClient` / `HttpCommerceClient` (no new
 * primitive): the injected `ctx.http.fetch` is the ONLY egress, money is integer
 * minor units + ISO-4217 currency on the wire, and the wire types are defined
 * LOCALLY — this module NEVER imports `@urumi/domain`, keeping the plugin
 * sandbox-clean (enforced by the dependency-cruiser rule, MOD-4). `#fetch` is
 * `#`-prefixed so the sandbox-clean grep guard sees no bare fetch call.
 */

export interface OrderSummaryWire {
	id: string;
	state: string;
	currency: string;
	buyerRef: string;
	customerId: string | null;
	paymentMethod: string | null;
	createdAt: string;
	totalCents: number;
	reconciliationFlag: boolean;
}

export interface OrderLineWire {
	sku: string;
	title: string;
	unitPriceCents: number;
	currency: string;
	quantity: number;
	fulfillmentKind: string;
}

export interface OrderTotalsWire {
	currency: string;
	subtotalCents: number;
	discountCents: number;
	shippingCents: number;
	taxCents: number;
	totalCents: number;
	appliedCouponCode: string | null;
	/** The chosen shipping zone id (ADR-0009), or null when none was selected.
	 *  DISPLAY-ONLY: rendered next to the captured ship-to country so a human can
	 *  spot a "domestic zone / foreign country" mismatch — no matching/validation. */
	shippingZoneId?: string | null;
}

/** The immutable shipping-address snapshot captured on an order at checkout
 *  (ADR-0009), or null when none was captured (a historical order predating
 *  capture, or a digital-only order). This IS the authoritative ship-to for the
 *  order — unlike {@link AddressWire} (the mutable profile book), it never changes
 *  after checkout. Optional contact fields are null when the buyer omitted them. */
export interface OrderAddressWire {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	email: string | null;
	phone: string | null;
}

/** The admin disposition recorded when an order's reconciliation flag was
 *  resolved (admin-UX Increment 1); null while unflagged/unresolved. */
export interface ReconciliationResolutionWire {
	outcome: string;
	reason: string;
	resolvedBy: string;
	resolvedAt: string;
}

/** The shipping fulfillment recorded on an order (admin-UX Increment 1); null
 *  until the order ships with tracking. `trackingUrl` is optional (null when the
 *  admin recorded none); `shippedAt` is the ship time, `recordedAt` the server
 *  stamp. */
export interface OrderFulfillmentWire {
	carrier: string;
	trackingNumber: string;
	trackingUrl: string | null;
	shippedAt: string;
	recordedBy: string;
	recordedAt: string;
}

/** The structured cancellation recorded on an order (admin-UX Increment 1,
 *  "cancel with reason"); null while never cancelled OR cancelled via the bare
 *  transition (no reason on file — an honest back-compat state). */
export interface OrderCancellationWire {
	reason: string;
	detail: string | null;
	cancelledBy: string;
	cancelledAt: string;
}

export interface OrderDetailWire {
	id: string;
	state: string;
	currency: string;
	paymentMethod: string | null;
	buyerRef: string;
	customerId: string | null;
	holdExpiresAt: string;
	createdAt: string;
	reconciliationFlag: string | null;
	reconciliationResolution: ReconciliationResolutionWire | null;
	fulfillment: OrderFulfillmentWire | null;
	cancellation: OrderCancellationWire | null;
	/** The immutable ship-to snapshot captured at checkout (ADR-0009); null when
	 *  the order predates capture or is digital-only. Authoritative — never the
	 *  profile book (which is prefill/context, on the customer panel). */
	shippingAddress: OrderAddressWire | null;
	totals: OrderTotalsWire;
	lines: OrderLineWire[];
}

/** The list filter the console builds from its filter form. `states` is an OR set
 *  (serialized to a CSV `states=` param); the window is half-open `[from, to)`. */
export interface OrdersListFilter {
	states?: string[];
	from?: string;
	to?: string;
	search?: string;
}

export interface OrdersListResult {
	orders: OrderSummaryWire[];
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
}

export interface OrderDetailResult {
	order: OrderDetailWire;
	/** The legal outbound transitions from the current state — the domain state
	 *  machine, forwarded by the service (never re-derived plugin-side). */
	allowedTransitions: string[];
}

/** A saved profile address on the wire (admin-UX Increment 1). This is the
 *  customer's CURRENT address book — prefill/context only (ADR-0009). The order's
 *  own authoritative ship-to is {@link OrderAddressWire} on the order detail; this
 *  mutable book must never be presented as "where this order shipped". */
export interface AddressWire {
	id: string;
	kind: string;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	isDefault: boolean;
	createdAt: string;
}

/** Token-free session metadata on the wire (admin-UX Increment 1) — the service
 *  never serializes a token or hash into this shape. */
export interface SessionSummaryWire {
	id: string;
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
}

/** Who the order's customer is (admin-UX Increment 1). `linkage` is the honest
 *  story: "claimed" (order linked to the account), "unclaimed" (an account
 *  exists for this email but the order predates its next login — links then),
 *  or "guest" (no account at all). */
export interface CustomerIdentityWire {
	customerId: string | null;
	buyerRef: string;
	email: string | null;
	displayName: string | null;
	emailVerifiedAt: string | null;
	linkage: string;
}

/** The customer-context panel payload (admin-UX Increment 1) — read-only. */
export interface CustomerContextWire {
	identity: CustomerIdentityWire;
	addresses: AddressWire[];
	sessions: SessionSummaryWire[];
	orderCount: number;
	recentOrders: OrderSummaryWire[];
}

/** An append-only order note (admin-UX Increment 0) on the wire. */
export interface OrderNoteWire {
	id: string;
	orderId: string;
	author: string;
	body: string;
	createdAt: string;
}

/**
 * One entry in the order timeline (admin-UX Increment 1, timeline slice) on the
 * wire. A discriminated union keyed by `kind`; every entry carries `at`, and the
 * kind-specific fields are OPTIONAL here (the plugin reads only what a given
 * `kind` populates), so an unknown/future kind degrades to a bare `at` row rather
 * than throwing. Money-free — the timeline is an audit surface, not a totals one.
 */
export interface TimelineEntryWire {
	kind: string;
	at: string;
	/** state_change */
	fromState?: string | null;
	toState?: string | null;
	actor?: string | null;
	/** note */
	author?: string;
	body?: string;
	/** fulfillment */
	carrier?: string;
	trackingNumber?: string;
	trackingUrl?: string | null;
	shippedAt?: string;
	recordedBy?: string;
	/** cancellation */
	reason?: string;
	detail?: string | null;
	cancelledBy?: string;
	/** reconciliation_resolved */
	outcome?: string;
	resolvedBy?: string;
}

/** The order timeline payload (admin-UX Increment 1, timeline slice) — read-only.
 *  `stateChangesAudited` is false for a historical order whose transitions
 *  predate the audit table (a partial timeline). */
export interface OrderTimelineWire {
	orderId: string;
	stateChangesAudited: boolean;
	entries: TimelineEntryWire[];
}

/** POST add-note returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host. */
export type AddNoteResult =
	| { ok: true; appended: boolean; note: OrderNoteWire }
	| { ok: false; status: number };

/** POST transition returns a discriminated result (like `updateSettings`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host. */
export type TransitionOrderResult =
	| { ok: true; transitioned: boolean }
	| { ok: false; status: number };

/** POST resolve-reconciliation returns a discriminated result (like `transitionOrder`)
 *  so a failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `resolved:false` on a 2xx ⇒ the guarded flip found nothing to resolve (already
 *  resolved / lost race) — a benign no-op, not a failure. On a failure, `reason`
 *  carries the service's typed reason when one was returned (e.g.
 *  `RECONCILIATION_FLAG_CHANGED` — the live flag differs from the one reviewed, the
 *  console should tell the merchant to reload); the caller renders GENERIC copy
 *  keyed off it, never the raw status/URL. */
export type ResolveReconciliationResult =
	| { ok: true; resolved: boolean }
	| { ok: false; status: number; reason?: string };

/** POST record-fulfillment returns a discriminated result (like `transitionOrder`)
 *  so a failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `recorded:false` on a 2xx ⇒ the guarded flip found the order already shipped (a
 *  benign no-op, not a failure). On a failure, `reason` carries the service's typed
 *  reason when one was returned (e.g. `NOT_FULFILLABLE` — the order is not in
 *  `processing`); the caller renders GENERIC copy keyed off it, never the raw
 *  status/URL. */
export type RecordFulfillmentResult =
	| { ok: true; recorded: boolean }
	| { ok: false; status: number; reason?: string };

/** POST cancel returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `cancelled:false` on a 2xx ⇒ the guarded flip found the order already
 *  cancelled with a reason on file (a benign no-op, not a failure). On a
 *  failure, `reason` carries the service's typed reason when one was returned
 *  (e.g. `NOT_CANCELLABLE` — the order can no longer be cancelled); the caller
 *  renders GENERIC copy keyed off it, never the raw status/URL. */
export type CancelOrderResult =
	| { ok: true; cancelled: boolean }
	| { ok: false; status: number; reason?: string };

interface HttpErrorEnvelope {
	error?: string;
	reason?: string;
}

export interface AdminOrdersClientOptions {
	fetch: HttpAccess["fetch"];
	baseUrl: string;
	/** Admin token forwarded as `X-Internal-Token` on every guarded call. Sourced
	 *  by the page handler from write-only `ctx.kv` (`settings:internalToken`). */
	adminToken?: string;
	/** The machine write-gate token the service enforces as `X-Service-Token`
	 *  (ADR-0007), sourced from write-only `ctx.kv` (`settings:serviceToken`).
	 *  `POST /admin/orders/:id/transition` is a NON-GET, so the gate blocks it
	 *  without this when the service secret is set — hence it is attached to the
	 *  transition (the list/detail GET reads are gate-exempt, so they carry only
	 *  the admin token). Undefined ⇒ no header ⇒ byte-identical to today. */
	serviceToken?: string;
}

export class AdminOrdersClient {
	readonly #fetch: HttpAccess["fetch"];
	readonly #baseUrl: string;
	readonly #adminToken: string | undefined;
	readonly #serviceToken: string | undefined;

	constructor(options: AdminOrdersClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#adminToken = options.adminToken;
		this.#serviceToken = options.serviceToken;
	}

	async listOrders(
		filter: OrdersListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<OrdersListResult> {
		const q = new URLSearchParams();
		if (opts.cursor !== undefined && opts.cursor.length > 0) {
			// The service cursor already embeds the active filter — send ONLY the
			// cursor (+limit) when paging so the two never disagree.
			q.set("cursor", opts.cursor);
		} else {
			if (filter.states !== undefined && filter.states.length > 0) {
				q.set("states", filter.states.join(","));
			}
			if (filter.from !== undefined && filter.from.length > 0) q.set("from", filter.from);
			if (filter.to !== undefined && filter.to.length > 0) q.set("to", filter.to);
			if (filter.search !== undefined && filter.search.length > 0) q.set("search", filter.search);
		}
		if (opts.limit !== undefined) q.set("limit", String(opts.limit));
		const body = await this.#getJson<{ orders?: OrderSummaryWire[]; nextCursor?: string | null }>(
			`/admin/orders?${q.toString()}`,
		);
		return { orders: body.orders ?? [], nextCursor: body.nextCursor ?? null };
	}

	/** GET one order + its allowed transitions. A 404 resolves to `null` (the
	 *  console renders a "not found" state, not an error banner). */
	async getOrder(orderId: string): Promise<OrderDetailResult | null> {
		const res = await this.#fetch(`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}`, {
			method: "GET",
			headers: this.#authHeaders(),
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET order failed (HTTP ${res.status})`);
		const body = (await res.json()) as {
			order: OrderDetailWire;
			allowedTransitions?: string[];
		};
		return { order: body.order, allowedTransitions: body.allowedTransitions ?? [] };
	}

	async transitionOrder(
		orderId: string,
		toState: string,
		opts: { idempotencyKey: string },
	): Promise<TransitionOrderResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		// The transition POST is gated by BOTH the write gate (X-Service-Token) AND
		// the route's admin token (X-Internal-Token) when both secrets are set.
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/transition`,
			{ method: "POST", headers, body: JSON.stringify({ toState }) },
		);
		const parsed = (await res.json().catch(() => undefined)) as
			| { ok?: boolean; transitioned?: boolean }
			| HttpErrorEnvelope
			| undefined;
		if (res.ok && parsed !== undefined && "ok" in parsed && parsed.ok === true) {
			return { ok: true, transitioned: parsed.transitioned ?? true };
		}
		// Fail with the status only — the caller renders a GENERIC banner that never
		// echoes a raw HTTP status/URL into the admin UI.
		return { ok: false, status: res.status };
	}

	/** POST resolve an order's reconciliation flag (admin-UX Increment 1). The body
	 *  carries `expectedFlag` — the flag detail AS DISPLAYED to the admin — and the
	 *  service compare-and-clears against it, so a mid-review re-flag conflicts
	 *  (`RECONCILIATION_FLAG_CHANGED`) instead of being cleared blind. Gated by
	 *  BOTH the admin token (X-Internal-Token) AND the write gate (X-Service-Token)
	 *  when both service secrets are set — a non-GET, same as the transition. Returns
	 *  a discriminated result. */
	async resolveReconciliation(
		orderId: string,
		disposition: { expectedFlag: string; outcome: string; reason: string; resolvedBy: string },
		opts: { idempotencyKey: string },
	): Promise<ResolveReconciliationResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/resolve-reconciliation`,
			{ method: "POST", headers, body: JSON.stringify(disposition) },
		);
		const parsed = (await res.json().catch(() => undefined)) as
			| { ok?: boolean; resolved?: boolean }
			| HttpErrorEnvelope
			| undefined;
		if (res.ok && parsed !== undefined && "ok" in parsed && parsed.ok === true) {
			return { ok: true, resolved: parsed.resolved ?? true };
		}
		// Forward the service's typed reason (if any) so the console can pick the
		// right GENERIC copy (e.g. "reload" on a flag-changed conflict) — never the
		// raw status/URL.
		const reason =
			parsed !== undefined && "reason" in parsed && typeof parsed.reason === "string"
				? parsed.reason
				: undefined;
		return { ok: false, status: res.status, ...(reason !== undefined ? { reason } : {}) };
	}

	/** POST record shipping fulfillment on an order (admin-UX Increment 1).
	 *  Recording fulfillment SHIPS the order (`processing → shipped`) and stores the
	 *  tracking so the buyer's shipped email carries it. Gated by BOTH the admin
	 *  token (X-Internal-Token) AND the write gate (X-Service-Token) when both
	 *  service secrets are set — a non-GET, same as the transition. Returns a
	 *  discriminated result; forwards the service's typed reason (e.g.
	 *  `NOT_FULFILLABLE`) so the console can pick the right GENERIC copy. */
	async recordFulfillment(
		orderId: string,
		fulfillment: {
			carrier: string;
			trackingNumber: string;
			trackingUrl?: string | null;
			shippedAt?: string | null;
			recordedBy: string;
		},
		opts: { idempotencyKey: string },
	): Promise<RecordFulfillmentResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/fulfillment`,
			{ method: "POST", headers, body: JSON.stringify(fulfillment) },
		);
		const parsed = (await res.json().catch(() => undefined)) as
			| { ok?: boolean; recorded?: boolean }
			| HttpErrorEnvelope
			| undefined;
		if (res.ok && parsed !== undefined && "ok" in parsed && parsed.ok === true) {
			return { ok: true, recorded: parsed.recorded ?? true };
		}
		const reason =
			parsed !== undefined && "reason" in parsed && typeof parsed.reason === "string"
				? parsed.reason
				: undefined;
		return { ok: false, status: res.status, ...(reason !== undefined ? { reason } : {}) };
	}

	/** POST cancel an order WITH a structured reason (admin-UX Increment 1,
	 *  "cancel with reason"). Gated by BOTH the admin token (X-Internal-Token) AND
	 *  the write gate (X-Service-Token) when both service secrets are set — a
	 *  non-GET, same as the transition. Returns a discriminated result; forwards
	 *  the service's typed reason (e.g. `NOT_CANCELLABLE`) so the console can pick
	 *  the right GENERIC copy. */
	async cancelOrder(
		orderId: string,
		cancellation: { reason: string; detail?: string | null; cancelledBy: string },
		opts: { idempotencyKey: string },
	): Promise<CancelOrderResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/cancel`,
			{ method: "POST", headers, body: JSON.stringify(cancellation) },
		);
		const parsed = (await res.json().catch(() => undefined)) as
			| { ok?: boolean; cancelled?: boolean }
			| HttpErrorEnvelope
			| undefined;
		if (res.ok && parsed !== undefined && "ok" in parsed && parsed.ok === true) {
			return { ok: true, cancelled: parsed.cancelled ?? true };
		}
		const cancelReason =
			parsed !== undefined && "reason" in parsed && typeof parsed.reason === "string"
				? parsed.reason
				: undefined;
		return {
			ok: false,
			status: res.status,
			...(cancelReason !== undefined ? { reason: cancelReason } : {}),
		};
	}

	/** GET an order's customer context (admin-token guarded read; admin-UX
	 *  Increment 1). Mirrors `getOrder`'s shape: a 404 resolves to `null`; any
	 *  other non-2xx throws — the caller degrades to an "unavailable" section,
	 *  never a hard error (and never blanks the order detail). */
	async getCustomerContext(orderId: string): Promise<CustomerContextWire | null> {
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/customer-context`,
			{ method: "GET", headers: this.#authHeaders() },
		);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET customer context failed (HTTP ${res.status})`);
		const body = (await res.json()) as { context?: CustomerContextWire };
		return body.context ?? null;
	}

	/** GET an order's timeline (admin-token guarded read; admin-UX Increment 1).
	 *  Mirrors `getCustomerContext`'s shape: a 404 resolves to `null`; any other
	 *  non-2xx throws — the caller degrades to an "unavailable" timeline section,
	 *  never a hard error (and never blanks the order detail). */
	async getTimeline(orderId: string): Promise<OrderTimelineWire | null> {
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/timeline`,
			{ method: "GET", headers: this.#authHeaders() },
		);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET timeline failed (HTTP ${res.status})`);
		const body = (await res.json()) as { timeline?: OrderTimelineWire };
		return body.timeline ?? null;
	}

	/** GET an order's append-only notes (admin-token guarded read). A non-2xx
	 *  throws — the caller degrades to an empty notes surface, never a hard error. */
	async listNotes(orderId: string): Promise<OrderNoteWire[]> {
		const body = await this.#getJson<{ notes?: OrderNoteWire[] }>(
			`/admin/orders/${encodeURIComponent(orderId)}/notes`,
		);
		return body.notes ?? [];
	}

	/** POST a new note. Gated by BOTH the admin token (X-Internal-Token) AND the
	 *  write gate (X-Service-Token) when both service secrets are set — a non-GET,
	 *  same as the transition. Returns a discriminated result. */
	async addNote(
		orderId: string,
		note: { author: string; body: string },
		opts: { idempotencyKey: string },
	): Promise<AddNoteResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/notes`,
			{ method: "POST", headers, body: JSON.stringify(note) },
		);
		const parsed = (await res.json().catch(() => undefined)) as
			| { ok?: boolean; appended?: boolean; note?: OrderNoteWire }
			| HttpErrorEnvelope
			| undefined;
		if (res.ok && parsed !== undefined && "ok" in parsed && parsed.ok === true && parsed.note) {
			return { ok: true, appended: parsed.appended ?? true, note: parsed.note };
		}
		return { ok: false, status: res.status };
	}

	#authHeaders(): Record<string, string> {
		return this.#adminToken === undefined ? {} : { "X-Internal-Token": this.#adminToken };
	}

	async #getJson<T>(path: string): Promise<T> {
		const res = await this.#fetch(`${this.#baseUrl}${path}`, {
			method: "GET",
			headers: this.#authHeaders(),
		});
		if (!res.ok) throw new Error(`GET ${path} failed (HTTP ${res.status})`);
		return (await res.json()) as T;
	}
}
