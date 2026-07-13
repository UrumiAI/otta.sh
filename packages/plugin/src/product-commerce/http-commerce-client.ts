import type { HttpAccess } from "../types.js";
import {
	CommerceClientError,
	type AddressWire,
	type AuthedResult,
	type CartLineWire,
	type CartResult,
	type CartWire,
	type CommerceClient,
	type LoginVerifyResult,
	type OrderSummaryWire,
	type ProductCommerce,
	type ProductCommerceBatchItem,
	type UpsertProductCommerceInput,
} from "./commerce-client.js";

export interface HttpCommerceClientOptions {
	/** `ctx.http.fetch` — the ONLY egress the sandbox grants (`network:request`
	 *  + `allowedHosts`). Never the ambient global `fetch`. */
	fetch: HttpAccess["fetch"];
	baseUrl: string;
	/** The machine write-gate token the service enforces as `X-Service-Token`
	 *  (ADR-0007), sourced by the construction site from write-only `ctx.kv`
	 *  (`settings:serviceToken`) via `serviceTokenFromKv`. Undefined ⇒ no header
	 *  is attached ⇒ byte-identical to the pre-gate wire. Attached to EVERY
	 *  request (incl. GET reads and `logout`) — see `#baseHeaders`. */
	serviceToken?: string;
}

/**
 * `CommerceClient` over `ctx.http` (plan §5/§6). Serializes each call as a
 * straight 1:1 mirror of the service REST API — `Idempotency-Key` as a
 * header, money as integer + ISO-4217 currency, no status-code-as-logic
 * beyond the envelope the service already defines (adapter-architecture
 * rule #2).
 */
export class HttpCommerceClient implements CommerceClient {
	readonly #fetch: HttpAccess["fetch"];
	readonly #baseUrl: string;
	readonly #serviceToken: string | undefined;

	constructor(options: HttpCommerceClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#serviceToken = options.serviceToken;
	}

	/** Merge the `X-Service-Token` write-gate header (ADR-0007) into every
	 *  request's headers when a token is configured. Attached uniformly —
	 *  including GET reads (harmless: GET is gate-exempt) — so a future reader
	 *  never has to reason about which verbs need it. NOTE `getCommerceBatch` is
	 *  a POST *read* that genuinely requires the header (the write gate blocks
	 *  ALL non-GET), so the header must NOT be "optimized off" storefront paths. */
	#baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
		return this.#serviceToken === undefined
			? extra
			: { ...extra, "X-Service-Token": this.#serviceToken };
	}

	async upsertProductCommerce(
		productId: string,
		input: UpsertProductCommerceInput,
		idempotencyKey: string,
	): Promise<ProductCommerce> {
		const res = await this.#fetch(this.#url(productId), {
			method: "PUT",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify(input),
		});
		return this.#json<ProductCommerce>(res);
	}

	async getProductCommerce(productId: string): Promise<ProductCommerce | null> {
		const res = await this.#fetch(this.#url(productId), {
			method: "GET",
			headers: this.#baseHeaders(),
		});
		return this.#json<ProductCommerce | null>(res);
	}

	async softDeleteProductCommerce(productId: string, idempotencyKey: string): Promise<void> {
		const res = await this.#fetch(this.#url(productId), {
			method: "DELETE",
			headers: this.#baseHeaders({ "Idempotency-Key": idempotencyKey }),
		});
		await this.#json<{ ok: true }>(res);
	}

	async activateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void> {
		const res = await this.#fetch(`${this.#url(productId)}/activate`, {
			method: "POST",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify({ contentUpdatedAt }),
		});
		await this.#json<{ ok: true }>(res);
	}

	async deactivateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void> {
		const res = await this.#fetch(`${this.#url(productId)}/deactivate`, {
			method: "POST",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify({ contentUpdatedAt }),
		});
		await this.#json<{ ok: true }>(res);
	}

	// ── Phase 2: catalog batch read (plan §6) ─────────────────────────────
	// (A later Phase-3 task adds its cart methods below this block — keep
	// the delimiters so the diff surfaces stay additive.)

	/** `POST /catalog/commerce/batch` — one request per page of ids (the
	 *  request-scoped loader guarantees the "one" part; the service's id cap
	 *  is the size guard). No idempotency key: a pure read. */
	async getCommerceBatch(productIds: string[]): Promise<ProductCommerceBatchItem[]> {
		const res = await this.#fetch(`${this.#baseUrl}/catalog/commerce/batch`, {
			method: "POST",
			headers: this.#baseHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ productIds }),
		});
		const body = await this.#json<{ items: ProductCommerceBatchItem[] }>(res);
		return body.items;
	}

	// ── end Phase 2 catalog batch read ────────────────────────────────────

	// ── Phase 3 group E: cart (plan §6 step 6) ────────────────────────────
	// Straight 1:1 mirrors of `@urumi/service`'s `routes/carts.ts`. Typed
	// cart failures (`OUT_OF_STOCK`/`CART_NOT_FOUND`/…) ride a MIX of 200/
	// 404/409 at the wire (adapter-architecture rule #2 — no status-code-
	// as-logic); `#cartResult` normalizes all of them to the same
	// `{ ok: false; reason }` shape regardless of status, so callers never
	// branch on an HTTP code. Only a genuinely unexpected response (no
	// `ok`/`reason` envelope — a malformed body, a 500, a 400 validation
	// reject) still throws `CommerceClientError`.

	/** `POST /carts` — no typed-failure envelope; a non-2xx here is a client
	 *  bug (bad currency), not a business outcome, so it throws. */
	async createCart(currency?: string): Promise<{ cartId: string }> {
		const res = await this.#fetch(`${this.#baseUrl}/carts`, {
			method: "POST",
			headers: this.#baseHeaders({ "content-type": "application/json" }),
			body: JSON.stringify(currency === undefined ? {} : { currency }),
		});
		return this.#json<{ cartId: string }>(res);
	}

	/** `GET /carts/:cartId` — runs lazy-expiry server-side first; 404 ⇒ typed
	 *  `CART_NOT_FOUND`, never a thrown error for that expected case. */
	async getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>> {
		const res = await this.#fetch(`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}`, {
			method: "GET",
			headers: this.#baseHeaders(),
		});
		return this.#cartResult<{ cart: CartWire }>(res);
	}

	/** `POST /carts/:cartId/lines` — `Idempotency-Key` header (CLAUDE.md: every
	 *  command carries one); `OUT_OF_STOCK` is a typed 200 body. */
	async addCartLine(
		cartId: string,
		sku: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		const res = await this.#fetch(`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}/lines`, {
			method: "POST",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify({ sku, qty }),
		});
		return this.#cartResult<{ line: CartLineWire }>(res);
	}

	/** `PATCH /carts/:cartId/lines/:lineId` — delta-free on the wire: the
	 *  caller sends the target qty, the service applies the delta. */
	async adjustCartLine(
		cartId: string,
		lineId: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		const res = await this.#fetch(
			`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}/lines/${encodeURIComponent(lineId)}`,
			{
				method: "PATCH",
				headers: this.#baseHeaders({
					"content-type": "application/json",
					"Idempotency-Key": idempotencyKey,
				}),
				body: JSON.stringify({ qty }),
			},
		);
		return this.#cartResult<{ line: CartLineWire }>(res);
	}

	/** `DELETE /carts/:cartId/lines/:lineId`. */
	async removeCartLine(
		cartId: string,
		lineId: string,
		idempotencyKey: string,
	): Promise<CartResult<Record<string, never>>> {
		const res = await this.#fetch(
			`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}/lines/${encodeURIComponent(lineId)}`,
			{ method: "DELETE", headers: this.#baseHeaders({ "Idempotency-Key": idempotencyKey }) },
		);
		return this.#cartResult<Record<string, never>>(res);
	}

	/** Normalizes a cart response to `{ok:true,...}`/`{ok:false,reason}`
	 *  regardless of HTTP status — the typed-failure envelope IS the
	 *  contract, not the status code (adapter-architecture rule #2). Falls
	 *  back to throwing `CommerceClientError` only when the body carries no
	 *  recognizable envelope at all. */
	async #cartResult<T extends Record<string, unknown>>(res: Response): Promise<CartResult<T>> {
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (isCartEnvelope(body)) return body as CartResult<T>;
		throw new CommerceClientError(res.status, body);
	}
	// ── end Phase 3 group E: cart ─────────────────────────────────────────

	// -- Phase 4: checkout + entitlement seam ---------------------------------
	// (A clearly-delimited additive block — Phase 2 adds `getCommerceBatch` to
	// this same file in parallel.) These mirror the service's Phase-4 endpoints
	// 1:1; delivery authorization for a digital download is a pure READ, so it
	// carries no secret and needs no auth header.

	/**
	 * Delivery authorization (§6/§7): true iff an active entitlement exists for
	 * `{orderId|buyerRef} + sku`. The download route serves the file only when
	 * this returns true.
	 */
	async checkEntitlement(
		scope: { orderId?: string; buyerRef?: string },
		sku: string,
	): Promise<boolean> {
		const params = new URLSearchParams({ sku });
		if (scope.orderId !== undefined) params.set("orderId", scope.orderId);
		if (scope.buyerRef !== undefined) params.set("buyerRef", scope.buyerRef);
		const res = await this.#fetch(`${this.#baseUrl}/entitlements/check?${params.toString()}`, {
			method: "GET",
			headers: this.#baseHeaders(),
		});
		const body = await this.#json<{ ok: boolean; active?: boolean }>(res);
		return body.active === true;
	}

	// -------------------------------------------------------------------------

	// ── Phase 5: storefront customer account (plan §7) ─────────────────────
	// 1:1 mirrors of the service's /auth + /me routes. The bearer session token
	// is threaded from the plugin's first-party cookie layer; a 401 is
	// normalized to a typed `UNAUTHENTICATED` the account route turns into a
	// redirect (never a thrown error for that expected case).

	/** `POST /auth/login/request` — always a generic success (no enumeration
	 *  oracle, §9 Risk 4). */
	async requestLoginLink(email: string): Promise<{ ok: true }> {
		await this.#fetch(`${this.#baseUrl}/auth/login/request`, {
			method: "POST",
			headers: this.#baseHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ email }),
		});
		return { ok: true };
	}

	/** `POST /auth/login/verify` — 200 ⇒ session token; 401 ⇒ typed reason. */
	async verifyLogin(challengeId: string, token: string): Promise<LoginVerifyResult> {
		const res = await this.#fetch(`${this.#baseUrl}/auth/login/verify`, {
			method: "POST",
			headers: this.#baseHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ challengeId, token }),
		});
		const body = (await res.json().catch(() => undefined)) as
			| { sessionToken?: string; expiresAt?: string; reason?: string }
			| undefined;
		if (res.ok && body?.sessionToken !== undefined && body.expiresAt !== undefined) {
			return { ok: true, sessionToken: body.sessionToken, expiresAt: body.expiresAt };
		}
		const reason = body?.reason;
		if (reason === "EXPIRED" || reason === "INVALID" || reason === "CONSUMED") {
			return { ok: false, reason };
		}
		return { ok: false, reason: "INVALID" };
	}

	/** `POST /auth/logout` — best-effort revoke; idempotent server-side. */
	async logout(sessionToken: string): Promise<void> {
		await this.#fetch(`${this.#baseUrl}/auth/logout`, {
			method: "POST",
			headers: this.#authHeaders(sessionToken),
		});
	}

	async listMyOrders(sessionToken: string): Promise<AuthedResult<{ orders: OrderSummaryWire[] }>> {
		const res = await this.#fetch(`${this.#baseUrl}/me/orders`, {
			method: "GET",
			headers: this.#authHeaders(sessionToken),
		});
		if (res.status === 401) return { ok: false, reason: "UNAUTHENTICATED" };
		const body = await this.#json<{ orders: OrderSummaryWire[] }>(res);
		return { ok: true, orders: body.orders };
	}

	async getMyOrder(
		sessionToken: string,
		orderId: string,
	): Promise<
		{ ok: true; order: OrderSummaryWire } | { ok: false; reason: "UNAUTHENTICATED" | "NOT_FOUND" }
	> {
		const res = await this.#fetch(`${this.#baseUrl}/me/orders/${encodeURIComponent(orderId)}`, {
			method: "GET",
			headers: this.#authHeaders(sessionToken),
		});
		if (res.status === 401) return { ok: false, reason: "UNAUTHENTICATED" };
		if (res.status === 404) return { ok: false, reason: "NOT_FOUND" };
		const body = await this.#json<{ order: OrderSummaryWire }>(res);
		return { ok: true, order: body.order };
	}

	async listMyAddresses(sessionToken: string): Promise<AuthedResult<{ addresses: AddressWire[] }>> {
		const res = await this.#fetch(`${this.#baseUrl}/me/addresses`, {
			method: "GET",
			headers: this.#authHeaders(sessionToken),
		});
		if (res.status === 401) return { ok: false, reason: "UNAUTHENTICATED" };
		const body = await this.#json<{ addresses: AddressWire[] }>(res);
		return { ok: true, addresses: body.addresses };
	}

	/** Session-auth headers. `authorization: Bearer <session>` is the CUSTOMER
	 *  session token (owned by the service's session auth); the write-gate
	 *  `X-Service-Token` is merged in alongside it (ADR-0007) — the two headers
	 *  are orthogonal, so `logout` and the `/me/*` reads carry BOTH when a service
	 *  token is configured, exactly what the gate + session auth each require. */
	#authHeaders(sessionToken: string): Record<string, string> {
		return this.#baseHeaders({ authorization: `Bearer ${sessionToken}` });
	}
	// ── end Phase 5 customer account ───────────────────────────────────────

	#url(productId: string): string {
		return `${this.#baseUrl}/products/${encodeURIComponent(productId)}/commerce`;
	}

	async #json<T>(res: Response): Promise<T> {
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (!res.ok) {
			throw new CommerceClientError(res.status, body);
		}
		return body as T;
	}
}

/** True for both `{ok:true,...}` and `{ok:false,reason:<string>}` — the two
 *  shapes `@urumi/service`'s cart routes' `failure()`/success bodies take. */
function isCartEnvelope(body: unknown): body is { ok: boolean; reason?: unknown } {
	if (typeof body !== "object" || body === null || !("ok" in body)) return false;
	const ok = (body as { ok: unknown }).ok;
	if (ok === true) return true;
	if (ok === false) return typeof (body as { reason?: unknown }).reason === "string";
	return false;
}
