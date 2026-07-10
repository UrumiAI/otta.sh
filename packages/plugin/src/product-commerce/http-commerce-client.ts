import type { HttpAccess } from "../types.js";
import {
	CommerceClientError,
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
