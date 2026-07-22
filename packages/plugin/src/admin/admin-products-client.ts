import type { HttpAccess } from "../types.js";

/**
 * A tiny `ctx.http`-only client for the admin Products console service surface
 * (view-only list + detail — admin-UX Increment 2, the enumerate slice). Same
 * transport discipline as `AdminOrdersClient` (no new primitive): the injected
 * `ctx.http.fetch` is the ONLY egress, money is integer minor units + ISO-4217
 * currency on the wire, and the wire types are defined LOCALLY — this module
 * NEVER imports `@urumi/domain`, keeping the plugin sandbox-clean (enforced by
 * the dependency-cruiser rule, MOD-4). `#fetch` is `#`-prefixed so the
 * sandbox-clean grep guard sees no bare fetch call.
 *
 * Read surface plus the guarded commerce EDIT (`updateProduct`, slice 2) and
 * the merchant stock movements (`restock` / `removeStock`, slice 3 — admin-UX
 * Increment 2). No product-CREATE method here (that stays in the CMS sync path).
 */

/** A lightweight product row for the admin list — NEVER carries stock (the
 *  list must not N+1 into inventory per row; see `AdminProductsClient.
 *  getProduct`'s doc for the detail leaf's single-sku read). */
export interface ProductSummaryWire {
	productId: string;
	sku: string | null;
	title: string | null;
	priceCents: number | null;
	currency: string | null;
	productKind: string;
	active: boolean;
	createdAt: string;
}

/** The full admin Product detail (read-only) — includes the single-sku stock
 *  read (`onHand`) the detail leaf fetches, unlike the list projection. */
export interface ProductDetailWire {
	productId: string;
	sku: string | null;
	title: string | null;
	priceCents: number | null;
	currency: string | null;
	taxClass: string | null;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: string;
	active: boolean;
	onHand: number;
	createdAt: string;
	updatedAt: string;
}

/** The list filter the console builds from its filter form. `active` is a
 *  tri-state string ("" ⇒ both) so the wire query mirrors the service's
 *  `active=true|false` param exactly. */
export interface ProductsListFilter {
	active?: boolean;
	productKind?: string;
	search?: string;
}

export interface ProductsListResult {
	products: ProductSummaryWire[];
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
}

/** The commerce-owned fields a product edit may change (mirrors the service's
 *  `editProductCommerceBody`). `expectedUpdatedAt` is the optimistic-concurrency
 *  watermark the admin loaded; the service compare-and-sets on it. Money is an
 *  integer minor-units + ISO-4217 pair — never a float. NO `active` (the CMS
 *  publish gate is not edited here). */
export interface ProductEditWire {
	expectedUpdatedAt: string;
	sku?: string;
	price?: { amount: number; currency: string };
	title?: string | null;
	taxClass?: string | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: string;
}

/** Discriminated edit outcome — the plugin renders each without status-code-as-
 *  logic (stale → reload notice, currency/sku → per-field warning). */
export type ProductEditResult =
	| { ok: true; updatedAt: string | null }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; currentUpdatedAt: string | null }
	| { ok: false; reason: "currency_mismatch"; currency: string | null }
	| { ok: false; reason: "sku_taken"; sku: string | null }
	| { ok: false; reason: "invalid"; field: string | null }
	| { ok: false; reason: "error" };

/** Discriminated restock outcome (admin-UX Increment 2 slice 3). `not_found`/
 *  `no_sku`/`no_inventory_row` are the productId → sku resolution failures; the
 *  panel renders each without treating a status code as logic. */
export type RestockResult =
	| { ok: true; onHand: number }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "no_sku" }
	| { ok: false; reason: "no_inventory_row" }
	| { ok: false; reason: "invalid" }
	| { ok: false; reason: "error" };

/** Discriminated stock-removal outcome (admin-UX Increment 2 slice 3). Adds
 *  `insufficient_stock` (carrying the current count) — the guarded floor that
 *  keeps a removal from ever driving on-hand below zero. */
export type StockRemovalResult =
	| { ok: true; onHand: number }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "no_sku" }
	| { ok: false; reason: "no_inventory_row" }
	| { ok: false; reason: "insufficient_stock"; onHand: number }
	| { ok: false; reason: "invalid" }
	| { ok: false; reason: "error" };

export interface AdminProductsClientOptions {
	fetch: HttpAccess["fetch"];
	baseUrl: string;
	/** Admin token forwarded as `X-Internal-Token` on every guarded read.
	 *  Sourced by the page handler from write-only `ctx.kv`
	 *  (`settings:internalToken`). */
	adminToken?: string;
	/** The machine write-gate token (`X-Service-Token`, ADR-0007), sourced from
	 *  write-only `ctx.kv`. Attached to the edit PATCH (a NON-GET the gate blocks
	 *  without it); undefined ⇒ no header ⇒ identical to a deployment with the
	 *  service secret unset. */
	serviceToken?: string;
}

export class AdminProductsClient {
	readonly #fetch: HttpAccess["fetch"];
	readonly #baseUrl: string;
	readonly #adminToken: string | undefined;
	readonly #serviceToken: string | undefined;

	constructor(options: AdminProductsClientOptions) {
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#adminToken = options.adminToken;
		this.#serviceToken = options.serviceToken;
	}

	/**
	 * PATCH the commerce-owned fields of one product (admin-UX Increment 2 slice
	 * 2). Gated by BOTH the admin token (X-Internal-Token) AND the write gate
	 * (X-Service-Token) when both secrets are set. `key` is the stable
	 * idempotency key (a double-submit dedupes). The HTTP status maps 1:1 to the
	 * discriminated result so the caller never inspects a raw status.
	 */
	async updateProduct(
		productId: string,
		body: ProductEditWire,
		key: string,
	): Promise<ProductEditResult> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/products/${encodeURIComponent(productId)}`,
			{ method: "PATCH", headers, body: JSON.stringify(body) },
		);
		if (res.status === 200) {
			const parsed = (await safeJson(res)) as { updatedAt?: string } | undefined;
			return { ok: true, updatedAt: parsed?.updatedAt ?? null };
		}
		if (res.status === 404) return { ok: false, reason: "not_found" };
		if (res.status === 400) {
			const parsed = (await safeJson(res)) as { field?: string } | undefined;
			return { ok: false, reason: "invalid", field: parsed?.field ?? null };
		}
		if (res.status === 409) {
			const parsed = (await safeJson(res)) as
				| { reason?: string; currentUpdatedAt?: string; currency?: string; sku?: string }
				| undefined;
			if (parsed?.reason === "STALE_EDIT") {
				return { ok: false, reason: "stale", currentUpdatedAt: parsed.currentUpdatedAt ?? null };
			}
			if (parsed?.reason === "CURRENCY_MISMATCH") {
				return { ok: false, reason: "currency_mismatch", currency: parsed.currency ?? null };
			}
			if (parsed?.reason === "SKU_TAKEN") {
				return { ok: false, reason: "sku_taken", sku: parsed.sku ?? null };
			}
			return { ok: false, reason: "error" };
		}
		return { ok: false, reason: "error" };
	}

	/**
	 * POST a merchant RESTOCK — ADD `qty` units to the product's stock (admin-UX
	 * Increment 2 slice 3). Gated by BOTH the admin token AND the write gate
	 * (X-Service-Token) when both secrets are set. `key` is REQUIRED and must be
	 * stable per submission: a restock is additive (not idempotent by nature), so
	 * the service has no safe content-only fallback — a double-submit dedupes only
	 * when the SAME key is sent. The HTTP status maps 1:1 to the discriminated
	 * result so the caller never inspects a raw status.
	 */
	async restock(productId: string, qty: number, key: string): Promise<RestockResult> {
		const res = await this.#postStockMovement(productId, "restock", qty, key);
		if (res.status === 200) {
			const parsed = (await safeJson(res)) as { onHand?: number } | undefined;
			return { ok: true, onHand: parsed?.onHand ?? 0 };
		}
		if (res.status === 404) return { ok: false, reason: "not_found" };
		if (res.status === 400) return { ok: false, reason: "invalid" };
		if (res.status === 409) {
			const reason = ((await safeJson(res)) as { reason?: string } | undefined)?.reason;
			if (reason === "NO_SKU") return { ok: false, reason: "no_sku" };
			if (reason === "NO_INVENTORY_ROW") return { ok: false, reason: "no_inventory_row" };
			return { ok: false, reason: "error" };
		}
		return { ok: false, reason: "error" };
	}

	/**
	 * POST a merchant STOCK REMOVAL — remove `qty` damaged/shrinkage units
	 * (admin-UX Increment 2 slice 3). Same double-gate + required-key discipline
	 * as {@link restock}. The service applies a GUARDED decrement, so an over-
	 * removal is a clean `insufficient_stock` (409, carrying the current count),
	 * never a negative stock or a throw.
	 */
	async removeStock(productId: string, qty: number, key: string): Promise<StockRemovalResult> {
		const res = await this.#postStockMovement(productId, "remove-stock", qty, key);
		if (res.status === 200) {
			const parsed = (await safeJson(res)) as { onHand?: number } | undefined;
			return { ok: true, onHand: parsed?.onHand ?? 0 };
		}
		if (res.status === 404) return { ok: false, reason: "not_found" };
		if (res.status === 400) return { ok: false, reason: "invalid" };
		if (res.status === 409) {
			const parsed = (await safeJson(res)) as { reason?: string; onHand?: number } | undefined;
			if (parsed?.reason === "NO_SKU") return { ok: false, reason: "no_sku" };
			if (parsed?.reason === "NO_INVENTORY_ROW") return { ok: false, reason: "no_inventory_row" };
			if (parsed?.reason === "INSUFFICIENT_STOCK") {
				return { ok: false, reason: "insufficient_stock", onHand: parsed.onHand ?? 0 };
			}
			return { ok: false, reason: "error" };
		}
		return { ok: false, reason: "error" };
	}

	#postStockMovement(
		productId: string,
		verb: "restock" | "remove-stock",
		qty: number,
		key: string,
	): Promise<Response> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		};
		if (this.#adminToken !== undefined) headers["X-Internal-Token"] = this.#adminToken;
		if (this.#serviceToken !== undefined) headers["X-Service-Token"] = this.#serviceToken;
		return this.#fetch(`${this.#baseUrl}/admin/products/${encodeURIComponent(productId)}/${verb}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ qty }),
		});
	}

	async listProducts(
		filter: ProductsListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<ProductsListResult> {
		const q = new URLSearchParams();
		if (opts.cursor !== undefined && opts.cursor.length > 0) {
			// The service cursor already embeds the active filter — send ONLY the
			// cursor (+limit) when paging so the two never disagree.
			q.set("cursor", opts.cursor);
		} else {
			if (filter.active !== undefined) q.set("active", filter.active ? "true" : "false");
			if (filter.productKind !== undefined && filter.productKind.length > 0) {
				q.set("productKind", filter.productKind);
			}
			if (filter.search !== undefined && filter.search.length > 0) q.set("search", filter.search);
		}
		if (opts.limit !== undefined) q.set("limit", String(opts.limit));
		const body = await this.#getJson<{
			products?: ProductSummaryWire[];
			nextCursor?: string | null;
		}>(`/admin/products?${q.toString()}`);
		return { products: body.products ?? [], nextCursor: body.nextCursor ?? null };
	}

	/** GET one product's full detail (incl. stock). A 404 resolves to `null`
	 *  (the console renders a "not found" state, not an error banner). */
	async getProduct(productId: string): Promise<ProductDetailWire | null> {
		const res = await this.#fetch(
			`${this.#baseUrl}/admin/products/${encodeURIComponent(productId)}`,
			{ method: "GET", headers: this.#authHeaders() },
		);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET product failed (HTTP ${res.status})`);
		const body = (await res.json()) as { product: ProductDetailWire };
		return body.product;
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

/** Parse a response body as JSON, tolerating an empty/invalid body (a structured
 *  error the plugin still classifies by status). */
async function safeJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
}
