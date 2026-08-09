import type { HttpAccess } from "../types.js";
import { CURSOR_REFUSED, isCursorRefusal } from "./cursor-refusal.js";

/**
 * A tiny `ctx.http`-only client for the admin Orders console service surface
 * (view-only list + detail, plus the existing status transition). Same transport
 * discipline as `ReportingSettingsClient` / `HttpCommerceClient` (no new
 * primitive): the injected `ctx.http.fetch` is the ONLY egress, money is integer
 * minor units + ISO-4217 currency on the wire, and the wire types are defined
 * LOCALLY — this module NEVER imports `@otta-sh/domain`, keeping the plugin
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
	/**
	 * Exact number of orders matching the ACTIVE FILTER — the whole set, not
	 * this page (INC-23).
	 *
	 * OPTIONAL for one reason only: a service older than the field omits it, and
	 * a renderer must then fall back to the page-scoped count it always had
	 * ("25 orders on this page"). Never defaulted to `0` — that would caption a
	 * page of rows with a count of none.
	 */
	total?: number;
	/**
	 * THIS IS PAGE ONE, and it is page one because the cursor the caller asked
	 * with was REFUSED — mismatched against these filters, or undecodable — and
	 * {@link AdminOrdersClient.listOrders} re-issued the request without it.
	 *
	 * ABSENT ON EVERY ORDINARY PAGE, including an ordinary first page: the flag
	 * means "you asked for a page you did not get", which is a thing a renderer
	 * must be able to say out loud (an address still naming that page has to be
	 * corrected, and an operator who followed a link to it deserves a sentence).
	 * A caller that ignores it renders a correct list, one page from where the
	 * caller meant — the safe direction, and the reason this is optional rather
	 * than a second result type.
	 */
	cursorRejected?: true;
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

/** A refund row on the wire (ADR-0008). `kind` is "gateway" (money moved via the
 *  provider — `refundRef` set) or "manual" (an out-of-band return the admin
 *  recorded — `refundRef` null, x402's honest path). Money is integer minor
 *  units + ISO-4217 currency. */
export interface RefundWire {
	id: string;
	orderId: string;
	amountCents: number;
	currency: string;
	kind: string;
	gateway: string;
	refundRef: string | null;
	reason: string | null;
	refundedBy: string;
	createdAt: string;
}

/** The refunds summary for an order (ADR-0008): the append-only ledger plus the
 *  derived ceiling / remaining-refundable and the gateway's HONEST `refundable`
 *  capability, so the panel shows the right action (a real Stripe refund vs a
 *  recorded manual refund) and never a button that silently no-ops. */
export interface RefundsSummaryWire {
	refunds: RefundWire[];
	currency: string;
	capturedTotalCents: number;
	refundedTotalCents: number;
	ceilingCents: number;
	remainingCents: number;
	paymentMethod: string | null;
	refundable: boolean;
}

/** POST refund returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `recorded:false` on a 2xx ⇒ an idempotent replay (`duplicate`). On a failure,
 *  `reason` carries the service's typed reason when one was returned (e.g.
 *  `REFUND_EXCEEDS_TOTAL`, `PROVIDER_ALREADY_REFUNDED`, `GATEWAY_UNVERIFIED`); the
 *  caller renders GENERIC copy keyed off it, never the raw status/URL. */
export type RefundOrderResult =
	| { ok: true; recorded: boolean; duplicate: boolean; fullyRefunded: boolean }
	| { ok: false; status: number; reason?: string };

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

	/**
	 * THE FILTER TRAVELS BESIDE THE CURSOR, and it did not used to.
	 *
	 * The old rule was "send ONLY the cursor when paging, so the two never
	 * disagree", and it was the wrong half of a true observation. The cursor does
	 * embed the filter it was minted under — but the route, given both, took the
	 * predicate SOLELY from the token and never read the query's filter params at
	 * all. So a page-two request that meant "paid orders" while carrying an
	 * unfiltered token got the unfiltered set, 200, with nothing in the response
	 * admitting the substitution; upstream, a console deriving its filters from
	 * the address captions those rows "Paid". Sending only the cursor did not
	 * prevent the disagreement — it hid it.
	 *
	 * The route now compares the two as PREDICATES and answers
	 * `400 {"error":"cursor filter mismatch"}` when they differ, so stating the
	 * filter on every request is what turns an invisible divergence into an
	 * answerable one. Agreeing params are byte-identical to the cursor alone: they
	 * are redundant, not a second opinion.
	 *
	 * NO CASE FOLDING, HERE OR ANYWHERE BETWEEN THE URL AND THE WIRE. The
	 * comparison is deliberately case-SENSITIVE — the store's case-insensitivity
	 * is the store's business, and a token round-trips whatever the query said —
	 * so a client that helpfully lowercased a search term on one request and not
	 * on the other would manufacture mismatches out of nothing.
	 *
	 * WHAT THE CALLER OWES: for a filter derived from a RELATIVE period, the
	 * instants passed here must be the ones the cursor was minted under, not a
	 * fresh resolution of the same words. `orders-read.ts`'s `periodWindow`
	 * resolves presets to WHOLE-DAY bounds precisely so that holds — two requests
	 * on the same UTC day resolve identically, which is every request in a paging
	 * session bar one that crosses UTC midnight. That crossing describes a
	 * genuinely different window, so the 400 and the page-one recovery below are
	 * the correct answer to it rather than a defect to design around.
	 */
	async listOrders(
		filter: OrdersListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<OrdersListResult> {
		const paged = opts.cursor !== undefined && opts.cursor.length > 0;
		const query = (withCursor: boolean): string => {
			const q = new URLSearchParams();
			if (withCursor && opts.cursor !== undefined) q.set("cursor", opts.cursor);
			if (filter.states !== undefined && filter.states.length > 0) {
				q.set("states", filter.states.join(","));
			}
			if (filter.from !== undefined && filter.from.length > 0) q.set("from", filter.from);
			if (filter.to !== undefined && filter.to.length > 0) q.set("to", filter.to);
			if (filter.search !== undefined && filter.search.length > 0) q.set("search", filter.search);
			if (opts.limit !== undefined) q.set("limit", String(opts.limit));
			return q.toString();
		};

		const first = await this.#getList(`/admin/orders?${query(paged)}`);
		if (first === CURSOR_REFUSED) {
			/*
			 * THE PRESCRIBED RECOVERY, PERFORMED HERE. A refused cursor means "drop
			 * the token and re-issue page one with these parameters", not "show the
			 * operator an error": the request is answerable, just not from that
			 * token, and the remedy is mechanical.
			 *
			 * IT BELONGS AT THIS TIER because this is the last one that can read the
			 * service's own error value, and the distinction it carries is the one the
			 * console needs most: a refused PAGE comes back as a first page with a
			 * flag, an unreachable SERVICE comes back as a thrown failure, and those
			 * two want opposite treatments of the address bar — the first is corrected
			 * to page one, the second must keep the page it names so a reload after
			 * recovery still restores it. Collapsing them into one "list failed" is
			 * what made the console guess.
			 *
			 * ONE retry, without the cursor, so it cannot loop: the second request
			 * carries no token to be refused.
			 */
			const retried = await this.#getList(`/admin/orders?${query(false)}`);
			if (retried === CURSOR_REFUSED) throw new Error("GET /admin/orders failed (HTTP 400)");
			return { ...retried, cursorRejected: true };
		}
		return first;
	}

	async #getList(path: string): Promise<OrdersListResult | typeof CURSOR_REFUSED> {
		const res = await this.#fetch(`${this.#baseUrl}${path}`, {
			method: "GET",
			headers: this.#authHeaders(),
		});
		if (!res.ok) {
			if (await isCursorRefusal(res)) return CURSOR_REFUSED;
			throw new Error(`GET ${path} failed (HTTP ${res.status})`);
		}
		const body = (await res.json()) as {
			orders?: OrderSummaryWire[];
			nextCursor?: string | null;
			total?: unknown;
		};
		return {
			orders: body.orders ?? [],
			nextCursor: body.nextCursor ?? null,
			// ABSENT STAYS ABSENT (never `?? 0`) — see `OrdersListResult.total`.
			...(typeof body.total === "number" ? { total: body.total } : {}),
		};
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

	/** GET an order's refunds summary (admin-token guarded read; ADR-0008): the
	 *  ledger + derived ceiling/remaining + the gateway's honest capability. A 404
	 *  resolves to `null`; any other non-2xx throws — the caller degrades to an
	 *  "unavailable" refunds section, never a hard error (and never blanks the
	 *  order detail). */
	async getRefunds(orderId: string): Promise<RefundsSummaryWire | null> {
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/refunds`,
			{ method: "GET", headers: this.#authHeaders() },
		);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET refunds failed (HTTP ${res.status})`);
		const body = (await res.json()) as Partial<RefundsSummaryWire>;
		return {
			refunds: body.refunds ?? [],
			currency: body.currency ?? "",
			capturedTotalCents: body.capturedTotalCents ?? 0,
			refundedTotalCents: body.refundedTotalCents ?? 0,
			ceilingCents: body.ceilingCents ?? 0,
			remainingCents: body.remainingCents ?? 0,
			paymentMethod: body.paymentMethod ?? null,
			refundable: body.refundable ?? false,
		};
	}

	/** POST issue/record a refund (ADR-0008). Gated by BOTH the admin token
	 *  (X-Internal-Token) AND the write gate (X-Service-Token) when both service
	 *  secrets are set — a non-GET, same as the transition. The `Idempotency-Key`
	 *  is REQUIRED (refunds are additive — two deliberate refunds must not
	 *  collapse). Returns a discriminated result; forwards the service's typed
	 *  reason so the console can pick the right GENERIC copy. */
	async refundOrder(
		orderId: string,
		refund: { amountCents: number; currency: string; reason?: string | null; refundedBy: string },
		opts: { idempotencyKey: string },
	): Promise<RefundOrderResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/orders/${encodeURIComponent(orderId)}/refund`,
			{ method: "POST", headers, body: JSON.stringify(refund) },
		);
		const parsed = (await res.json().catch(() => undefined)) as
			| { ok?: boolean; recorded?: boolean; duplicate?: boolean; fullyRefunded?: boolean }
			| HttpErrorEnvelope
			| undefined;
		if (res.ok && parsed !== undefined && "ok" in parsed && parsed.ok === true) {
			return {
				ok: true,
				recorded: parsed.recorded ?? true,
				duplicate: parsed.duplicate ?? false,
				fullyRefunded: parsed.fullyRefunded ?? false,
			};
		}
		const reason =
			parsed !== undefined && "reason" in parsed && typeof parsed.reason === "string"
				? parsed.reason
				: undefined;
		return { ok: false, status: res.status, ...(reason !== undefined ? { reason } : {}) };
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
