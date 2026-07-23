import type { HttpAccess } from "../types.js";

/**
 * A tiny `ctx.http`-only client for the admin RULES service surface — shipping
 * (zones → methods → rates), tax (classes, rates) and coupons (admin-UX
 * Increment 3). Same transport discipline as `AdminOrdersClient` /
 * `AdminProductsClient` (no new primitive): the injected `ctx.http.fetch` is the
 * ONLY egress, money is integer minor units + ISO-4217 currency on the wire, and
 * the wire types are defined LOCALLY — this module NEVER imports `@urumi/domain`,
 * keeping the plugin sandbox-clean (enforced by the dependency-cruiser rule,
 * MOD-4). `#fetch` is `#`-prefixed so the sandbox-clean grep guard sees no bare
 * fetch call.
 *
 * Covers the FULL rules surface: the existing reads + creates AND the new
 * UPDATE/DELETE capability this slice adds. No UI is built here (later slices
 * consume this client). Every mutation forwards BOTH the admin token
 * (`X-Internal-Token`) and, when set, the write-gate token (`X-Service-Token`);
 * reads are gate-exempt GETs and carry only the admin token.
 */

// -- Wire types (local; never `@urumi/domain`) --------------------------------

export interface ShippingZoneWire {
	id: string;
	name: string;
	regions: unknown;
}

export interface ShippingMethodWire {
	id: string;
	zoneId: string;
	name: string;
	/** 'flat_rate' | 'free_shipping'. */
	type: string;
}

export interface ShippingRateWire {
	methodId: string;
	currency: string;
	amountCents: number;
	minSubtotalCents: number | null;
}

export interface TaxClassWire {
	id: string;
	name: string;
}

export interface TaxRateWire {
	id: string;
	taxClassId: string;
	zoneId: string;
	rateBps: number;
	appliesToShipping: boolean;
}

/** Mirrors the service `serializeCoupon` shape (start/expiry are intentionally
 *  not serialized by the service, so they are absent here). */
export interface CouponWire {
	id: string;
	code: string;
	type: string;
	amountCents: number | null;
	rateBps: number | null;
	capCents: number | null;
	currency: string | null;
	minSubtotalCents: number | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
	usesCount: number;
}

/** One admin Coupons-list row (admin-UX Increment 3, view-only enumerate).
 *  Mirrors `CouponWire` plus `createdAt` — a small, header-only table has
 *  nothing expensive to trim off the list projection (unlike
 *  `ProductSummaryWire`, which deliberately narrows the full product row).
 *  `usesCount` doubles as the redeemed indicator (already a plain column, no
 *  join). */
export interface CouponSummaryWire {
	id: string;
	code: string;
	type: string;
	amountCents: number | null;
	rateBps: number | null;
	capCents: number | null;
	currency: string | null;
	minSubtotalCents: number | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
	usesCount: number;
	createdAt: string;
}

/** The list filter the console builds from its filter form. `search` is the
 *  ONLY axis this slice ships (coupons have no soft-delete/publish-gate/kind
 *  axis to mirror `ProductsListFilter`'s `deleted`/`active`/`productKind`) —
 *  a case-insensitive EXACT match on `code`, never a substring. */
export interface CouponsListFilter {
	search?: string;
}

export interface CouponsListResult {
	coupons: CouponSummaryWire[];
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
}

// -- Discriminated results ----------------------------------------------------
// A failure NEVER throws into the host; it surfaces a typed reason the caller
// renders as GENERIC copy, never a raw HTTP status/URL.

/** Create outcome — a 2xx carries the created row; anything else is a status. */
export type RulesCreateResult<T> = { ok: true; value: T } | { ok: false; status: number };

/** LWW-update outcome (zones, methods, coupons) — no `stale` (no CAS). */
export type RulesUpdateResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "error"; status: number };

/** CAS-update outcome (shipping/tax rates) — `stale` carries the fresh row so
 *  the caller can reload rather than blind-retry a losing edit. */
export type RulesCasUpdateResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; current: T | null }
	| { ok: false; reason: "error"; status: number };

/** Delete outcome. `in_use` is the referential-guard refusal (a zone with
 *  methods, a method with rates, a redeemed coupon); leaf-rate deletes never
 *  return it. `not_found` is the idempotent no-op. */
export type RulesDeleteResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use" }
	| { ok: false; reason: "error"; status: number };

// -- Input shapes -------------------------------------------------------------

export interface ShippingZoneInput {
	id: string;
	name: string;
	regions?: unknown;
}
/** Full-replace edit — `regions` is REQUIRED (the service 400s an omitted key
 *  so an edit can never silently wipe the zone's match list); send `null` to
 *  clear deliberately. */
export interface ShippingZoneEdit {
	name: string;
	regions: unknown;
}
export interface ShippingMethodInput {
	id: string;
	name: string;
	type: string;
}
export interface ShippingMethodEdit {
	name: string;
	type: string;
}
export interface ShippingRateInput {
	currency: string;
	amountCents: number;
	minSubtotalCents?: number | null;
}
/** Full-replace edit — `minSubtotalCents` is REQUIRED-nullable (the service
 *  400s an omitted key so an edit can never silently clear the free-shipping
 *  threshold); send `null` to clear deliberately. */
export interface ShippingRateEdit {
	amountCents: number;
	minSubtotalCents: number | null;
	/** The money-bearing CAS token — the amount the admin read on the detail. */
	expectedAmountCents: number;
}
export interface TaxClassInput {
	id: string;
	name: string;
}
export interface TaxRateInput {
	id: string;
	taxClassId: string;
	zoneId: string;
	rateBps: number;
	appliesToShipping?: boolean;
}
/** Full-replace edit — `appliesToShipping` is REQUIRED (the service 400s an
 *  omitted key so an edit can never silently flip the shipping-tax behavior). */
export interface TaxRateEdit {
	rateBps: number;
	appliesToShipping: boolean;
	/** The money-bearing CAS token — the rate the admin read on the detail. */
	expectedRateBps: number;
}
export interface CouponInput {
	id: string;
	code: string;
	type: string;
	amountCents?: number | null;
	rateBps?: number | null;
	capCents?: number | null;
	currency?: string | null;
	minSubtotalCents?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxUses?: number | null;
	maxUsesPerCustomer?: number | null;
}
/** Coupon edit — `id`/`code`/`type`/`currency` are immutable identity/kind and
 *  are NOT sent (the service rejects re-defining them). */
export interface CouponEdit {
	amountCents?: number | null;
	rateBps?: number | null;
	capCents?: number | null;
	minSubtotalCents?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxUses?: number | null;
	maxUsesPerCustomer?: number | null;
}

export interface AdminRulesClientOptions {
	fetch: HttpAccess["fetch"];
	baseUrl: string;
	/** Admin token forwarded as `X-Internal-Token` on every guarded call. */
	adminToken?: string;
	/** Machine write-gate token forwarded as `X-Service-Token` on every NON-GET. */
	serviceToken?: string;
}

export class AdminRulesClient {
	readonly #fetch: HttpAccess["fetch"];
	readonly #baseUrl: string;
	readonly #adminToken: string | undefined;
	readonly #serviceToken: string | undefined;

	constructor(options: AdminRulesClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#adminToken = options.adminToken;
		this.#serviceToken = options.serviceToken;
	}

	// -- Shipping: zones -------------------------------------------------------

	async listZones(): Promise<ShippingZoneWire[]> {
		const body = await this.#getJson<{ zones?: ShippingZoneWire[] }>("/admin/shipping/zones");
		return body.zones ?? [];
	}

	async createZone(input: ShippingZoneInput): Promise<RulesCreateResult<ShippingZoneWire>> {
		return this.#create<ShippingZoneWire>("/admin/shipping/zones", input, "zone");
	}

	async updateZone(
		zoneId: string,
		edit: ShippingZoneEdit,
	): Promise<RulesUpdateResult<ShippingZoneWire>> {
		const res = await this.#write(
			"PUT",
			`/admin/shipping/zones/${encodeURIComponent(zoneId)}`,
			edit,
		);
		return this.#lwwResult<ShippingZoneWire>(res, "zone");
	}

	async deleteZone(zoneId: string): Promise<RulesDeleteResult> {
		const res = await this.#write("DELETE", `/admin/shipping/zones/${encodeURIComponent(zoneId)}`);
		return this.#deleteResult(res);
	}

	// -- Shipping: methods -----------------------------------------------------

	async listMethods(zoneId: string): Promise<ShippingMethodWire[]> {
		const body = await this.#getJson<{ methods?: ShippingMethodWire[] }>(
			`/admin/shipping/zones/${encodeURIComponent(zoneId)}/methods`,
		);
		return body.methods ?? [];
	}

	async createMethod(
		zoneId: string,
		input: ShippingMethodInput,
	): Promise<RulesCreateResult<ShippingMethodWire>> {
		return this.#create<ShippingMethodWire>(
			`/admin/shipping/zones/${encodeURIComponent(zoneId)}/methods`,
			input,
			"method",
		);
	}

	async updateMethod(
		methodId: string,
		edit: ShippingMethodEdit,
	): Promise<RulesUpdateResult<ShippingMethodWire>> {
		const res = await this.#write(
			"PUT",
			`/admin/shipping/methods/${encodeURIComponent(methodId)}`,
			edit,
		);
		return this.#lwwResult<ShippingMethodWire>(res, "method");
	}

	async deleteMethod(methodId: string): Promise<RulesDeleteResult> {
		const res = await this.#write(
			"DELETE",
			`/admin/shipping/methods/${encodeURIComponent(methodId)}`,
		);
		return this.#deleteResult(res);
	}

	// -- Shipping: rates -------------------------------------------------------

	async getRate(methodId: string, currency: string): Promise<ShippingRateWire | null> {
		const q = new URLSearchParams({ currency });
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/shipping/methods/${encodeURIComponent(methodId)}/rates?${q.toString()}`,
			{ method: "GET", headers: this.#authHeaders() },
		);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET shipping rate failed (HTTP ${res.status})`);
		const body = (await res.json()) as { rate?: ShippingRateWire };
		return body.rate ?? null;
	}

	async createRate(
		methodId: string,
		input: ShippingRateInput,
	): Promise<RulesCreateResult<ShippingRateWire>> {
		return this.#create<ShippingRateWire>(
			`/admin/shipping/methods/${encodeURIComponent(methodId)}/rates`,
			input,
			"rate",
		);
	}

	async updateRate(
		methodId: string,
		currency: string,
		edit: ShippingRateEdit,
	): Promise<RulesCasUpdateResult<ShippingRateWire>> {
		const res = await this.#write(
			"PUT",
			`/admin/shipping/methods/${encodeURIComponent(methodId)}/rates/${encodeURIComponent(currency)}`,
			edit,
		);
		return this.#casResult<ShippingRateWire>(res, "rate");
	}

	async deleteRate(methodId: string, currency: string): Promise<RulesDeleteResult> {
		const res = await this.#write(
			"DELETE",
			`/admin/shipping/methods/${encodeURIComponent(methodId)}/rates/${encodeURIComponent(currency)}`,
		);
		return this.#deleteResult(res);
	}

	// -- Tax: classes ----------------------------------------------------------

	async listTaxClasses(): Promise<TaxClassWire[]> {
		const body = await this.#getJson<{ classes?: TaxClassWire[] }>("/admin/tax/classes");
		return body.classes ?? [];
	}

	async createTaxClass(input: TaxClassInput): Promise<RulesCreateResult<TaxClassWire>> {
		return this.#create<TaxClassWire>("/admin/tax/classes", input, "taxClass");
	}

	// -- Tax: rates ------------------------------------------------------------

	async listTaxRates(zoneId: string): Promise<TaxRateWire[]> {
		const q = new URLSearchParams({ zoneId });
		const body = await this.#getJson<{ rates?: TaxRateWire[] }>(`/admin/tax/rates?${q.toString()}`);
		return body.rates ?? [];
	}

	async createTaxRate(input: TaxRateInput): Promise<RulesCreateResult<TaxRateWire>> {
		return this.#create<TaxRateWire>("/admin/tax/rates", input, "rate");
	}

	async updateTaxRate(
		rateId: string,
		edit: TaxRateEdit,
	): Promise<RulesCasUpdateResult<TaxRateWire>> {
		const res = await this.#write("PUT", `/admin/tax/rates/${encodeURIComponent(rateId)}`, edit);
		return this.#casResult<TaxRateWire>(res, "rate");
	}

	async deleteTaxRate(rateId: string): Promise<RulesDeleteResult> {
		const res = await this.#write("DELETE", `/admin/tax/rates/${encodeURIComponent(rateId)}`);
		return this.#deleteResult(res);
	}

	// -- Coupons ---------------------------------------------------------------

	/**
	 * GET the admin Coupons console list (admin-UX Increment 3, view-only
	 * enumerate — the missing atomic primitive this slice adds). Mirrors
	 * `AdminProductsClient.listProducts`'s shape: pass EITHER a fresh `filter`
	 * OR a previous page's `opts.cursor` (never both — the cursor already
	 * embeds the active filter, so sending a filter alongside it could disagree
	 * with what the server re-derives from the token).
	 */
	async listCoupons(
		filter: CouponsListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<CouponsListResult> {
		const q = new URLSearchParams();
		if (opts.cursor !== undefined && opts.cursor.length > 0) {
			q.set("cursor", opts.cursor);
		} else if (filter.search !== undefined && filter.search.length > 0) {
			q.set("search", filter.search);
		}
		if (opts.limit !== undefined) q.set("limit", String(opts.limit));
		const body = await this.#getJson<{
			coupons?: CouponSummaryWire[];
			nextCursor?: string | null;
		}>(`/admin/coupons?${q.toString()}`);
		return { coupons: body.coupons ?? [], nextCursor: body.nextCursor ?? null };
	}

	async getCoupon(code: string): Promise<CouponWire | null> {
		const res = await this.#fetch(`${this.#baseUrl}/admin/coupons/${encodeURIComponent(code)}`, {
			method: "GET",
			headers: this.#authHeaders(),
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET coupon failed (HTTP ${res.status})`);
		const body = (await res.json()) as { coupon?: CouponWire };
		return body.coupon ?? null;
	}

	async createCoupon(input: CouponInput): Promise<RulesCreateResult<CouponWire>> {
		return this.#create<CouponWire>("/admin/coupons", input, "coupon");
	}

	async updateCoupon(couponId: string, edit: CouponEdit): Promise<RulesUpdateResult<CouponWire>> {
		const res = await this.#write("PUT", `/admin/coupons/${encodeURIComponent(couponId)}`, edit);
		return this.#lwwResult<CouponWire>(res, "coupon");
	}

	async deleteCoupon(couponId: string): Promise<RulesDeleteResult> {
		const res = await this.#write("DELETE", `/admin/coupons/${encodeURIComponent(couponId)}`);
		return this.#deleteResult(res);
	}

	// -- internals -------------------------------------------------------------

	async #create<T>(path: string, body: unknown, field: string): Promise<RulesCreateResult<T>> {
		const res = await this.#write("POST", path, body);
		if (res.status >= 200 && res.status < 300) {
			const parsed = (await safeJson(res)) as Record<string, unknown> | undefined;
			const value = parsed?.[field] as T | undefined;
			if (value !== undefined) return { ok: true, value };
		}
		return { ok: false, status: res.status };
	}

	async #lwwResult<T>(res: Response, field: string): Promise<RulesUpdateResult<T>> {
		if (res.status === 200) {
			const parsed = (await safeJson(res)) as Record<string, unknown> | undefined;
			const value = parsed?.[field] as T | undefined;
			if (value !== undefined) return { ok: true, value };
			return { ok: false, reason: "error", status: res.status };
		}
		if (res.status === 404) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "error", status: res.status };
	}

	async #casResult<T>(res: Response, field: string): Promise<RulesCasUpdateResult<T>> {
		if (res.status === 200) {
			const parsed = (await safeJson(res)) as Record<string, unknown> | undefined;
			const value = parsed?.[field] as T | undefined;
			if (value !== undefined) return { ok: true, value };
			return { ok: false, reason: "error", status: res.status };
		}
		if (res.status === 404) return { ok: false, reason: "not_found" };
		if (res.status === 409) {
			const parsed = (await safeJson(res)) as { reason?: string; current?: T } | undefined;
			if (parsed?.reason === "STALE") {
				return { ok: false, reason: "stale", current: parsed.current ?? null };
			}
			return { ok: false, reason: "error", status: res.status };
		}
		return { ok: false, reason: "error", status: res.status };
	}

	async #deleteResult(res: Response): Promise<RulesDeleteResult> {
		if (res.status === 200) return { ok: true };
		if (res.status === 404) return { ok: false, reason: "not_found" };
		if (res.status === 409) return { ok: false, reason: "in_use" };
		return { ok: false, reason: "error", status: res.status };
	}

	#write(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Response> {
		const headers: Record<string, string> = {};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		return this.#fetch(`${this.#baseUrl}${path}`, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
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

async function safeJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
}
