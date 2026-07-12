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

/** POST transition returns a discriminated result (like `updateSettings`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host. */
export type TransitionOrderResult =
	| { ok: true; transitioned: boolean }
	| { ok: false; status: number };

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
}

export class AdminOrdersClient {
	readonly #fetch: HttpAccess["fetch"];
	readonly #baseUrl: string;
	readonly #adminToken: string | undefined;

	constructor(options: AdminOrdersClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#adminToken = options.adminToken;
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
