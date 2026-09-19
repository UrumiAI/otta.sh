import type { HttpAccess } from "../types.js";

/**
 * A tiny `ctx.http`-only client for the Phase-7 reporting + settings service
 * surface (plan §4.4/§5.3). Same transport discipline as `HttpCommerceClient`
 * (no new primitive): the injected `ctx.http.fetch` is the ONLY egress, money is
 * integer minor units + ISO-4217 currency on the wire, and the wire types are
 * defined locally (never importing `@otta-sh/domain`, keeping the plugin
 * sandbox-clean). `#fetch` is `#`-prefixed so the sandbox-clean grep guard sees
 * no bare fetch call.
 */

export interface RevenueBucketWire {
	bucketStart: string;
	currency: string;
	revenueCents: number;
	/**
	 * Money refunded on the orders in this bucket — integer minor units in the
	 * bucket's own `currency`, stated ALONGSIDE `revenueCents` and never netted
	 * into it.
	 *
	 * OPTIONAL ON THIS TYPE, AND ONLY FOR ONE REASON: a service older than the
	 * field omits the key. The current service emits it unconditionally, zero
	 * included — so `0` means "nothing came back", which is a FACT worth
	 * rendering as `$0.00`, and only the key's ABSENCE means "this service does
	 * not report refunds". A renderer must branch on presence, never on
	 * truthiness, and `?? 0` here would turn an unreportable period into a
	 * confident claim that nothing was refunded.
	 *
	 * Counts FINALIZED refunds (money that actually moved) against orders PLACED
	 * in the period — the same cohort `orders-by-status` counts, so the amount
	 * and the refunded-order count on one tile always describe the same set.
	 */
	refundedCents?: number;
}
export interface StatusCountWire {
	status: string;
	orderCount: number;
}
export interface TopProductWire {
	productId: string;
	titleSnapshot: string;
	qtySold: number;
	revenueCents: number;
}
export interface LowStockWire {
	sku: string;
	onHand: number;
	/** The LIVE product's title for this sku.
	 *
	 *  `null` when no live product claims the sku (never synced, soft-deleted,
	 *  or its own title is genuinely null) — and null is the ONLY fallback. The
	 *  service never substitutes the sku, which is already its own field on
	 *  this row; doing so would make "named SKU-42" and "name unknown"
	 *  indistinguishable and stop a renderer's `(untitled)` affordance from
	 *  ever firing. */
	title: string | null;
}
export interface OperationalSettingsWire {
	holdTtlMinutes: number;
	lowStockThreshold: number;
}

export interface DateRangeInput {
	from: string;
	to: string;
}

/**
 * WHY a settings save fails, STRUCTURALLY — the field a caller branches on
 * (work order 02, INC-B10c-ii).
 *
 *  - `validation` — the patch itself was refused. The `message` is the one worth
 *    showing inline beside the field.
 *  - `superseded` — the mutation lost a compare-and-set race against a
 *    concurrent save and was NOT applied. Not retryable under the same key: the
 *    key already decided, and the decision was "someone else got there first".
 *    Re-read and offer the fresh values rather than re-submitting.
 *  - `unavailable` — the store could not answer. Nothing is known about whether
 *    the patch applied; a re-read is the only honest next step.
 */
export type UpdateSettingsFailureReason = "validation" | "superseded" | "unavailable";

/**
 * PUT /settings returns a discriminated result rather than throwing, so the
 * form can surface a validation error INLINE instead of swallowing it into a
 * generic failure (§5.3).
 *
 * `reason` IS THE FIELD TO BRANCH ON, and `status` is the LEGACY fallback the
 * HTTP tier alone still carries. The in-process tier has no wire and therefore
 * no status: it refuses to synthesize one, because a fabricated `409` would be
 * indistinguishable from a real one and would teach a caller to read a transport
 * artefact that does not exist on that transport (the ratified INC-B10a rule —
 * a typed failure is represented structurally in-process, never mapped onto an
 * invented HTTP status). So BOTH keys are optional: a caller branches on
 * `reason` first and falls back to `status` only when `reason` is absent.
 */
export type UpdateSettingsResult =
	| { ok: true; settings: OperationalSettingsWire }
	| {
			ok: false;
			/** Present on every tier that can say WHY. Branch on this first. */
			reason?: UpdateSettingsFailureReason;
			/** The HTTP status, on the HTTP tier only. Never synthesized elsewhere. */
			status?: number;
			message: string;
	  };

export interface HttpErrorEnvelope {
	error?: string;
	message?: string;
}

export interface ReportingSettingsClientOptions {
	fetch: HttpAccess["fetch"];
	baseUrl: string;
	/** Admin token forwarded as `X-Internal-Token` on EVERY guarded read this
	 *  client makes — the `/reports/*` reads (review J5) AND `GET /settings`,
	 *  which is admin surface too (ADR-0010). Received here as a constructor
	 *  option; the handlers source it from write-only `ctx.kv`
	 *  from write-only plugin kv. The client itself never
	 *  persists it. The privileged `PUT /settings` write uses THIS token too:
	 *  `updateSettings` attaches `opts.adminToken ?? this.#adminToken`, so a
	 *  per-call token overrides it and the constructor's is the fallback — which is
	 *  the only path production takes, because the sole caller passes none. */
	adminToken?: string;
	/** The machine write-gate token the service enforces as `X-Service-Token`
	 *  (ADR-0007), sourced from write-only `ctx.kv`.
	 *  `PUT /settings` is a NON-GET, so the gate blocks it without this when the
	 *  service secret is set — hence it is attached to the PUT. The `/reports/*`
	 *  and `GET /settings` reads are exempt from THAT gate (it skips GET/HEAD), so
	 *  they carry only the admin token — which, since ADR-0010, they genuinely
	 *  need. Undefined ⇒ no header ⇒ byte-identical to the pre-gate wire. */
	serviceToken?: string;
}

export class ReportingSettingsClient {
	readonly #fetch: HttpAccess["fetch"];
	readonly #baseUrl: string;
	readonly #adminToken: string | undefined;
	readonly #serviceToken: string | undefined;

	constructor(options: ReportingSettingsClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#adminToken = options.adminToken;
		this.#serviceToken = options.serviceToken;
	}

	async getRevenue(
		range: DateRangeInput,
		interval: "day" | "week" | "month",
	): Promise<RevenueBucketWire[]> {
		const q = new URLSearchParams({ from: range.from, to: range.to, interval });
		const body = await this.#getJson<{ buckets: RevenueBucketWire[] }>(`/reports/revenue?${q}`);
		return body.buckets;
	}

	async getOrdersByStatus(range: DateRangeInput): Promise<StatusCountWire[]> {
		const q = new URLSearchParams({ from: range.from, to: range.to });
		const body = await this.#getJson<{ counts: StatusCountWire[] }>(
			`/reports/orders-by-status?${q}`,
		);
		return body.counts;
	}

	async getTopProducts(
		range: DateRangeInput,
		metric: "revenue" | "quantity",
		limit: number,
	): Promise<TopProductWire[]> {
		const q = new URLSearchParams({
			from: range.from,
			to: range.to,
			metric,
			limit: String(limit),
		});
		const body = await this.#getJson<{ products: TopProductWire[] }>(`/reports/top-products?${q}`);
		return body.products;
	}

	async getLowStock(threshold?: number): Promise<LowStockWire[]> {
		const path =
			threshold === undefined ? "/reports/low-stock" : `/reports/low-stock?threshold=${threshold}`;
		const body = await this.#getJson<{ rows: LowStockWire[] }>(path);
		return body.rows;
	}

	async getSettings(): Promise<OperationalSettingsWire> {
		const body = await this.#getJson<{ settings: OperationalSettingsWire }>("/settings");
		return body.settings;
	}

	async updateSettings(
		patch: Partial<OperationalSettingsWire>,
		opts: { idempotencyKey: string; adminToken?: string },
	): Promise<UpdateSettingsResult> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": opts.idempotencyKey,
		};
		// The per-call token wins, and the constructor's is the fallback — NOT the
		// other way round, and not "per-call only", which is what this did before
		// INC-B10c-ii. A client constructed WITH an admin token (as `makeAdminClients`
		// constructs it) would otherwise send none on the one call that needs it most
		// and take a 401 on a save whose reads all succeeded.
		const adminToken = opts.adminToken ?? this.#adminToken;
		if (adminToken !== undefined) headers["X-Internal-Token"] = adminToken;
		// PUT /settings is gated by BOTH the write gate (X-Service-Token) AND the
		// route's admin token (X-Internal-Token) when both service secrets are set.
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(`${this.#baseUrl}/settings`, {
			method: "PUT",
			headers,
			body: JSON.stringify(patch),
		});
		const parsed = (await res.json().catch(() => undefined)) as
			| { settings?: OperationalSettingsWire }
			| HttpErrorEnvelope
			| undefined;
		if (
			!res.ok ||
			parsed === undefined ||
			!("settings" in parsed) ||
			parsed.settings === undefined
		) {
			// Surface the service's own message ONLY for a designed validation
			// failure (400 + JSON message) — that inline text ("holdTtlMinutes must
			// be a positive integer") is desirable and shown as-is. For any other
			// non-ok case (401/403/5xx/non-JSON) fall back to a GENERIC message that
			// never leaks a raw HTTP status or URL (Part 5 consistency).
			const validationMessage =
				res.status === 400 &&
				parsed !== undefined &&
				"message" in parsed &&
				typeof parsed.message === "string"
					? parsed.message
					: undefined;
			const message =
				validationMessage ??
				// A gate 401 can now stem from EITHER the admin token or the service
				// token (ADR-0007) — name both so the remedy isn't misdirected (D5).
				"settings update failed — check the admin token and service token in Settings, and the service connection";
			return { ok: false, status: res.status, message };
		}
		return { ok: true, settings: parsed.settings };
	}

	async #getJson<T>(path: string): Promise<T> {
		const headers: Record<string, string> =
			this.#adminToken === undefined ? {} : { "X-Internal-Token": this.#adminToken };
		const res = await this.#fetch(`${this.#baseUrl}${path}`, { method: "GET", headers });
		if (!res.ok) {
			throw new Error(`GET ${path} failed (HTTP ${res.status})`);
		}
		return (await res.json()) as T;
	}
}

/**
 * The TIER-AGNOSTIC reporting + settings surface: what the Reports page, the
 * Settings form and the Products console hold, whichever transport serves it
 * (work order 02, INC-B10c-ii).
 *
 * A `Pick` rather than an `interface` the class implements, because the class is
 * NOMINAL — its `#`-private fields mean a structurally identical in-process twin
 * is not assignable to it — and a structural surface is what lets one page hold
 * either.
 *
 * EVERY METHOD IS LISTED, and that is the point. Adding a method to this client
 * without deciding what the in-process tier does about it has to be a compile
 * error here, not a runtime gap on whichever screen reached for it first.
 */
export type ReportingSettingsSurface = Pick<
	ReportingSettingsClient,
	| "getRevenue"
	| "getOrdersByStatus"
	| "getTopProducts"
	| "getLowStock"
	| "getSettings"
	| "updateSettings"
>;
