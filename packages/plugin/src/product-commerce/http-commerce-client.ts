import type { HttpAccess } from "../types.js";
import {
	CommerceClientError,
	type CartLineWire,
	type CartResult,
	type CartWire,
	type CommerceClient,
	type ProductCommerce,
	type ProductCommerceBatchItem,
	type UpsertProductCommerceInput,
} from "./commerce-client.js";

export interface HttpCommerceClientOptions {
	/** `ctx.http.fetch` — the ONLY egress the sandbox grants (`network:request`
	 *  + `allowedHosts`). Never the ambient global `fetch`. */
	fetch: HttpAccess["fetch"];
	baseUrl: string;
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

	constructor(options: HttpCommerceClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
	}

	async upsertProductCommerce(
		productId: string,
		input: UpsertProductCommerceInput,
		idempotencyKey: string,
	): Promise<ProductCommerce> {
		const res = await this.#fetch(this.#url(productId), {
			method: "PUT",
			headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
			body: JSON.stringify(input),
		});
		return this.#json<ProductCommerce>(res);
	}

	async getProductCommerce(productId: string): Promise<ProductCommerce | null> {
		const res = await this.#fetch(this.#url(productId), { method: "GET" });
		return this.#json<ProductCommerce | null>(res);
	}

	async softDeleteProductCommerce(productId: string, idempotencyKey: string): Promise<void> {
		const res = await this.#fetch(this.#url(productId), {
			method: "DELETE",
			headers: { "Idempotency-Key": idempotencyKey },
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
			headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
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
			headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
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
			headers: { "content-type": "application/json" },
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
			headers: { "content-type": "application/json" },
			body: JSON.stringify(currency === undefined ? {} : { currency }),
		});
		return this.#json<{ cartId: string }>(res);
	}

	/** `GET /carts/:cartId` — runs lazy-expiry server-side first; 404 ⇒ typed
	 *  `CART_NOT_FOUND`, never a thrown error for that expected case. */
	async getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>> {
		const res = await this.#fetch(`${this.#baseUrl}/carts/${encodeURIComponent(cartId)}`, {
			method: "GET",
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
			headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
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
				headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
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
			{ method: "DELETE", headers: { "Idempotency-Key": idempotencyKey } },
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
