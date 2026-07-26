import type { HttpAccess } from "../types.js";

/**
 * A tiny `ctx.http`-only client for the Phase-7 reporting + settings service
 * surface (plan §4.4/§5.3). Same transport discipline as `HttpCommerceClient`
 * (no new primitive): the injected `ctx.http.fetch` is the ONLY egress, money is
 * integer minor units + ISO-4217 currency on the wire, and the wire types are
 * defined locally (never importing `@urumi/domain`, keeping the plugin
 * sandbox-clean). `#fetch` is `#`-prefixed so the sandbox-clean grep guard sees
 * no bare fetch call.
 */

export interface RevenueBucketWire {
	bucketStart: string;
	currency: string;
	revenueCents: number;
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
}
export interface OperationalSettingsWire {
	holdTtlMinutes: number;
	lowStockThreshold: number;
}

export interface DateRangeInput {
	from: string;
	to: string;
}

/** PUT /settings returns a discriminated result rather than throwing, so the
 *  form can surface a `400` validation error INLINE instead of swallowing it
 *  into a generic failure (§5.3). */
export type UpdateSettingsResult =
	| { ok: true; settings: OperationalSettingsWire }
	| { ok: false; status: number; message: string };

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
	 *  (`settings:internalToken`) via `readAdminTokens`. The client itself never
	 *  persists it. (The privileged `PUT /settings` write takes its own
	 *  `adminToken` per-call — see `updateSettings`.) */
	adminToken?: string;
	/** The machine write-gate token the service enforces as `X-Service-Token`
	 *  (ADR-0007), sourced from write-only `ctx.kv` (`settings:serviceToken`).
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
		if (opts.adminToken !== undefined) headers["X-Internal-Token"] = opts.adminToken;
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
