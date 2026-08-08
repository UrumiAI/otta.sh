import type { HttpAccess } from "../types.js";
import {
	CommerceClientError,
	type AddressWire,
	type AuthedResult,
	type CartLineWire,
	type CartResult,
	type CartWire,
	type CheckoutFailureReason,
	type CheckoutRequestWire,
	type CheckoutResult,
	type CommerceClient,
	type LoginVerifyResult,
	type OrderSummaryWire,
	type PaymentIntentWire,
	type ProductCommerce,
	type ProductCommerceBatchItem,
	type ProductVariantSummaryWire,
	type ProductVariantWire,
	type PublicOrderResult,
	type PublicOrderWire,
	type QuoteBreakdownWire,
	type QuoteFailureReason,
	type QuoteRequestWire,
	type QuoteResult,
	type UpdateProductVariantFieldsInput,
	type UpsertProductCommerceInput,
	type UpsertProductVariantInput,
	type VariantUpdateResult,
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

	// ── Variants: one method per WRITER (ADR-0016) ────────────────────────
	// 1:1 mirrors of the service's `/products/:id/variants*` routes. The
	// variant key is a path SEGMENT and is `encodeURIComponent`-escaped: it is
	// opaque CMS text, so a key carrying a slash or a space must address its own
	// row rather than a route that does not exist.

	/** `GET /products/:id/variants` — every variant of one product, ordered by
	 *  key, ORPHANS INCLUDED and flagged. A pure read: no idempotency key, and
	 *  an unknown product is `[]` rather than an error. */
	async listProductVariants(productId: string): Promise<ProductVariantSummaryWire[]> {
		const res = await this.#fetch(this.#variantsUrl(productId), {
			method: "GET",
			headers: this.#baseHeaders(),
		});
		const body = await this.#json<{ variants: ProductVariantSummaryWire[] }>(res);
		return body.variants;
	}

	/** `PUT /products/:id/variants/:variantKey` — the CMS-sync declare. Sends
	 *  ONLY the name cache and the watermark; the body is `.strict()` at the
	 *  service, so a stray commercial field is a 400 rather than a silent drop. */
	async upsertProductVariant(
		productId: string,
		variantKey: string,
		input: UpsertProductVariantInput,
		idempotencyKey: string,
	): Promise<ProductVariantWire> {
		const res = await this.#fetch(this.#variantUrl(productId, variantKey), {
			method: "PUT",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify(input),
		});
		return this.#json<ProductVariantWire>(res);
	}

	/** `PATCH /products/:id/variants/:variantKey` — the guarded admin edit.
	 *  Every documented refusal is normalized to a typed VALUE; only a body with
	 *  no recognizable envelope at all still throws `CommerceClientError`. */
	async updateProductVariantFields(
		productId: string,
		variantKey: string,
		input: UpdateProductVariantFieldsInput,
		expectedUpdatedAt: string,
		idempotencyKey: string,
	): Promise<VariantUpdateResult> {
		const res = await this.#fetch(this.#variantUrl(productId, variantKey), {
			method: "PATCH",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify({ ...input, expectedUpdatedAt }),
		});
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (res.ok) return { ok: true, variant: body as ProductVariantWire };
		// The integrator commerce routes carry their machine code on `error`,
		// where the cart/checkout envelopes carry it on `reason`. Normalize to
		// `reason` HERE so every typed failure in this client reads the same way,
		// and a caller never has to know which family of routes answered it.
		const refusal = asVariantRefusal(body);
		if (refusal !== null) return refusal;
		throw new CommerceClientError(res.status, body);
	}

	/** `POST /products/:id/variants/:variantKey/deactivate` — the orphan
	 *  transition. Deactivation, never deletion; an unknown key is a no-op. */
	async deactivateProductVariant(
		productId: string,
		variantKey: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void> {
		const res = await this.#fetch(`${this.#variantUrl(productId, variantKey)}/deactivate`, {
			method: "POST",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify({ contentUpdatedAt }),
		});
		await this.#json<{ ok: true }>(res);
	}
	// ── end variants ──────────────────────────────────────────────────────

	// ── Phase 3 group E: cart (plan §6 step 6) ────────────────────────────
	// Straight 1:1 mirrors of `@otta-sh/service`'s `routes/carts.ts`. Typed
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
	 *  `CART_NOT_FOUND`, never a thrown error for that expected case.
	 *
	 *  Also NORMALIZES `cart.orderId` to `null` (issue #132). See the comment on
	 *  the coercion below for why the guard lives here and nowhere else. */
	async getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>> {
		const res = await this.#fetch(`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}`, {
			method: "GET",
			headers: this.#baseHeaders(),
		});
		const result = await this.#cartResult<{ cart: CartWire }>(res);
		// Nothing on this path validates the cart body at runtime: `#cartResult`
		// blind-casts once `isCartEnvelope` has confirmed only "an object with an
		// `ok` key". A field the service stops emitting therefore arrives as
		// `undefined`, fully type-checked.
		//
		// `state` fails SAFELY that way (`isCartTerminal(undefined)` is false).
		// `orderId` fails UNSAFELY: `undefined !== null` is true, so a consumer
		// renders `/orders/undefined` — a dead link offered as a primary action.
		// `""` is just as bad (`/orders/`), hence the length check as well as the
		// type check.
		//
		// It belongs HERE, in `getCart`: this is field-specific, and it sits at
		// the wire boundary where version skew actually lands (a new bundle
		// talking to an older deployed service). `HttpCommerceClient` is the sole
		// `CommerceClient` implementation, so this one coercion also covers
		// `cart-routes.ts`'s read route, `checkout-routes.ts`, and any consumer of
		// the published `CommerceClient.getCart`.
		//
		// NOT in `#cartResult`: that is generic over `T` and shared with
		// `addCartLine`/`adjustCartLine`/`removeCartLine`; special-casing a field
		// name inside a generic envelope normalizer is the wrong layer. And NOT
		// double-guarded downstream: `sites/staging` bundles `@otta-sh/plugin`
		// (`noExternal`), so site+plugin ship as ONE deployable and the only skew
		// boundary is (site+plugin) ⇄ service — a second guard would be redundant
		// by construction and would drift.
		//
		// The coercion is TOTAL, and that includes `cart` itself: the thesis above
		// is "this wire is unvalidated", and `isCartEnvelope` never checked for a
		// `cart` key either. A success envelope arriving without one — or with a
		// null or non-object one — is passed through EXACTLY as it was before this
		// PR rather than becoming a new `TypeError` thrown from inside the client.
		// Failing loud there would be defensible, but it would be an undocumented
		// behaviour change for a direct `CommerceClient.getCart` consumer, and the
		// guard costs one condition.
		const cart: unknown = result.ok ? result.cart : undefined;
		if (typeof cart === "object" && cart !== null) {
			const wire = cart as CartWire;
			const raw: unknown = wire.orderId;
			wire.orderId = typeof raw === "string" && raw.length > 0 ? raw : null;
		}
		return result;
	}

	/** `POST /carts/:cartId/lines` — `Idempotency-Key` header (CLAUDE.md: every
	 *  command carries one); `OUT_OF_STOCK` is a typed 200 body. */
	async addCartLine(
		cartId: string,
		sku: string,
		productId: string | null,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		const res = await this.#fetch(`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}/lines`, {
			method: "POST",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			// `productId` is the join key to `product_commerce` (issue #80): the
			// service resolves price/fulfillment kind from it, and a null productId
			// is why a storefront cart used to 409 PRODUCT_NOT_PRICED at checkout.
			// OMIT the key when null so the wire stays byte-identical to the
			// pre-#80 shape for a bare (legacy) add (the service body treats an
			// absent productId as null — `addLineBody`).
			body: JSON.stringify(productId === null ? { sku, qty } : { sku, qty, productId }),
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
	// 1:1. Delivery authorization is a READ, but NOT anonymous (issue #33 /
	// ADR-0011): the orderId scope is an unguessable bearer capability (no auth
	// header), and the session scope threads the customer's Bearer so the service
	// can derive the email server-side.

	/**
	 * Delivery authorization (§6/§7, ADR-0011), matching the service's
	 * presence-based scope precedence. Two scopes only:
	 *  - `orderId` — the download link's unguessable order id; an open bearer
	 *    capability, no auth header.
	 *  - session — a logged-in customer checks their OWN entitlements; the Bearer
	 *    session token is threaded and the service derives the email server-side.
	 * The plugin NEVER sends `buyerRef`: the raw-email scope is operator-only
	 * (`X-Internal-Token`), a secret the sandbox does not and must not hold — so a
	 * storefront path can never re-acquire the email existence oracle.
	 * A 401 (invalid/expired session) normalizes to a typed `UNAUTHENTICATED`
	 * (never a thrown error) — the download route turns it into a login redirect.
	 */
	async checkEntitlement(
		scope: { orderId?: string },
		sku: string,
		opts: { sessionToken?: string } = {},
	): Promise<AuthedResult<{ active: boolean }>> {
		const params = new URLSearchParams({ sku });
		if (scope.orderId !== undefined) params.set("orderId", scope.orderId);
		const headers =
			opts.sessionToken !== undefined ? this.#authHeaders(opts.sessionToken) : this.#baseHeaders();
		const res = await this.#fetch(`${this.#baseUrl}/entitlements/check?${params.toString()}`, {
			method: "GET",
			headers,
		});
		if (res.status === 401) return { ok: false, reason: "UNAUTHENTICATED" };
		const body = await this.#json<{ ok: boolean; active?: boolean }>(res);
		return { ok: true, active: body.active === true };
	}

	// -------------------------------------------------------------------------

	// ── Phase 4: checkout (storefront-checkout plan §1.2) ────────────────────
	// 1:1 mirrors of `POST /checkout/quote`, `POST /checkout/orders` and
	// `GET /orders/:orderId`. Typed failures ride a MIX of 400/404/409/502 at
	// the wire; `#envelopeResult` normalizes every one of them to the same
	// `{ ok: false, reason }` value (adapter rule #2 — no status-code-as-logic),
	// so a 502 `PAYMENT_INTENT_FAILED` is a business outcome the checkout page
	// can explain, never a thrown transport error. Only a body with no
	// recognizable envelope at all (a zod parse reject, a 500) still throws.

	/** `POST /checkout/quote` — a read, but a POST, so the write gate blocks it
	 *  without `X-Service-Token`. Never redeems a coupon: safe to repeat. */
	async quoteCheckout(input: QuoteRequestWire): Promise<QuoteResult> {
		const res = await this.#fetch(`${this.#baseUrl}/checkout/quote`, {
			method: "POST",
			headers: this.#baseHeaders({ "content-type": "application/json" }),
			body: JSON.stringify(input),
		});
		return this.#envelopeResult<{ breakdown: QuoteBreakdownWire }, QuoteFailureReason>(res);
	}

	/** `POST /checkout/orders` — mints the order, holds stock for the TTL and
	 *  creates the payment intent. `idempotencyKey` is the CALLER's and is
	 *  forwarded VERBATIM: a same-key replay returns the original order (and,
	 *  via Stripe's own native idempotency, the same PaymentIntent), which is
	 *  exactly what makes a reload of the pay step safe. */
	async createOrder(input: CheckoutRequestWire, idempotencyKey: string): Promise<CheckoutResult> {
		const res = await this.#fetch(`${this.#baseUrl}/checkout/orders`, {
			method: "POST",
			headers: this.#baseHeaders({
				"content-type": "application/json",
				"Idempotency-Key": idempotencyKey,
			}),
			body: JSON.stringify(input),
		});
		return this.#envelopeResult<
			{ order: PublicOrderWire; intent: PaymentIntentWire },
			CheckoutFailureReason
		>(res);
	}

	/** `GET /orders/:orderId` — the unauthenticated capability read (ADR-0010
	 *  §2). Deliberately sends NO `X-Internal-Token`: with one the service
	 *  answers the full admin projection (`buyerRef`, ship-to, reconciliation),
	 *  and this reply renders on a page any holder of the URL can open. The
	 *  storefront must only ever see `serializePublicOrder`'s whitelist. */
	async getPublicOrder(orderId: string): Promise<PublicOrderResult> {
		const res = await this.#fetch(`${this.#baseUrl}/orders/${encodeURIComponent(orderId)}`, {
			method: "GET",
			headers: this.#baseHeaders(),
		});
		return this.#envelopeResult<{ order: PublicOrderWire }, "ORDER_NOT_FOUND">(res);
	}

	/** The cart-envelope normalization, generalized over its failure token —
	 *  `#cartResult`'s shape, reused so checkout cannot drift from carts. */
	async #envelopeResult<T extends Record<string, unknown>, R extends string>(
		res: Response,
	): Promise<({ ok: true } & T) | { ok: false; reason: R }> {
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (isCartEnvelope(body)) return body as ({ ok: true } & T) | { ok: false; reason: R };
		throw new CommerceClientError(res.status, body);
	}
	// ── end Phase 4 checkout ─────────────────────────────────────────────────

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

	#variantsUrl(productId: string): string {
		return `${this.#baseUrl}/products/${encodeURIComponent(productId)}/variants`;
	}

	#variantUrl(productId: string, variantKey: string): string {
		return `${this.#variantsUrl(productId)}/${encodeURIComponent(variantKey)}`;
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

/**
 * Map one variant-edit refusal body onto its typed value, or `null` when the
 * body carries no refusal this client knows — which is what makes an unknown
 * shape throw instead of silently becoming a plausible-looking failure.
 *
 * The operands travel WITH the token on purpose: every one of these refusals is
 * something an operator has to act on (which sku is taken, which two skus a
 * rename spans, how many holds are still live, which watermark to reload), and
 * the service composes no sentence — the console does, from these fields, in one
 * place. A refusal whose operands are missing or the wrong type degrades to its
 * safe default rather than being rejected: the token is the decision, the
 * operands only sharpen the copy.
 */
function asVariantRefusal(body: unknown): VariantUpdateResult | null {
	if (typeof body !== "object" || body === null) return null;
	const row = body as Record<string, unknown>;
	if (row.ok !== false) return null;
	const text = (key: string): string | null => (typeof row[key] === "string" ? row[key] : null);
	switch (row.error) {
		case "VARIANT_NOT_FOUND":
			return { ok: false, reason: "VARIANT_NOT_FOUND" };
		case "STALE_EDIT":
			return { ok: false, reason: "STALE_EDIT", currentUpdatedAt: text("currentUpdatedAt") ?? "" };
		case "CURRENCY_MISMATCH":
			return { ok: false, reason: "CURRENCY_MISMATCH", currency: text("currency") };
		case "INVALID_FIELD":
			return { ok: false, reason: "INVALID_FIELD", field: text("field") ?? "" };
		case "SKU_TAKEN":
			return { ok: false, reason: "SKU_TAKEN", sku: text("sku") ?? "" };
		case "SKU_STOCK_CONFLICT":
			return {
				ok: false,
				reason: "SKU_STOCK_CONFLICT",
				fromSku: text("fromSku") ?? "",
				toSku: text("toSku") ?? "",
			};
		case "SKU_HELD_STOCK":
			return {
				ok: false,
				reason: "SKU_HELD_STOCK",
				sku: text("sku") ?? "",
				liveHolds: typeof row.liveHolds === "number" ? row.liveHolds : 0,
			};
		default:
			return null;
	}
}

/** True for both `{ok:true,...}` and `{ok:false,reason:<string>}` — the two
 *  shapes `@otta-sh/service`'s cart routes' `failure()`/success bodies take. */
function isCartEnvelope(body: unknown): body is { ok: boolean; reason?: unknown } {
	if (typeof body !== "object" || body === null || !("ok" in body)) return false;
	const ok = (body as { ok: unknown }).ok;
	if (ok === true) return true;
	if (ok === false) return typeof (body as { reason?: unknown }).reason === "string";
	return false;
}
