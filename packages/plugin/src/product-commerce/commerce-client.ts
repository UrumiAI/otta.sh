/**
 * The `CommerceClient` transport port (ADR-0002 §3 / plan §5): storefront
 * routes and the widget's save route depend on this INTERFACE, never on
 * `fetch` directly. `HttpCommerceClient` (http-commerce-client.ts) is the
 * only adapter this phase builds — `InProcessCommerceClient` is deferred
 * (ADR-0002 §6: no premature abstraction beyond a second real adapter).
 *
 * Wire types mirror `@urumi/service`'s `PUT/GET/DELETE /products/:id/commerce`
 * 1:1 (money as an integer + ISO-4217 string, never a float).
 */

export interface CommerceMoney {
	amount: number;
	currency: string;
}

export type CommerceProductKind = "physical" | "digital";

/** Every commercial field is optional — "create then price" (plan §1 case
 *  3): a bare content sync carries only the product_id. */
export interface UpsertProductCommerceInput {
	sku?: string;
	price?: CommerceMoney;
	taxClass?: string | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: CommerceProductKind;
	/** Initial stock — a create-if-absent seed attempted on any save that
	 *  carries it (self-healing after a partial failure, review B1); never a
	 *  restock path (plan §8 Risk 4). */
	initialOnHand?: number;
	/** Sync-ordering watermark (review S1): the CMS content's `updatedAt`,
	 *  sent by `content:afterSave` syncs so the service rejects a
	 *  delayed/out-of-order OLDER save as a stale no-op. Panel saves omit it
	 *  (explicit merchant intent = last-writer-wins, documented). */
	contentUpdatedAt?: string;
}

export interface ProductCommerce {
	productId: string;
	sku: string | null;
	price: CommerceMoney | null;
	taxClass: string | null;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: CommerceProductKind;
	active: boolean;
	deletedAt: string | null;
	contentUpdatedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

// ── Phase 2: catalog batch read (plan §6) ────────────────────────────────
// Wire item for `POST /catalog/commerce/batch` — mirrors the service's
// ProductCommerceView DTO 1:1. Only ids that exist come back; missing ids
// are OMITTED, never per-id errors. `inStock` is the service's own
// single intra-DB join (§6 invariant — the plugin never makes a second
// inventory round trip). Branding (Cents/Currency) happens one layer up,
// at `catalog/commerce-view.ts`'s parse boundary.
export interface ProductCommerceBatchItem {
	productId: string;
	sku: string;
	price: CommerceMoney;
	inStock: boolean;
}
// ── end Phase 2 catalog batch read ───────────────────────────────────────

export interface CommerceClient {
	upsertProductCommerce(
		productId: string,
		input: UpsertProductCommerceInput,
		idempotencyKey: string,
	): Promise<ProductCommerce>;
	getProductCommerce(productId: string): Promise<ProductCommerce | null>;
	softDeleteProductCommerce(productId: string, idempotencyKey: string): Promise<void>;

	// ── Phase 2: catalog batch read (plan §6) ─────────────────────────────
	// (A later Phase-3 task adds its cart methods below this block — keep
	// the delimiters so the diff surfaces stay additive.)
	getCommerceBatch(productIds: string[]): Promise<ProductCommerceBatchItem[]>;
	// ── end Phase 2 catalog batch read ────────────────────────────────────
}

/** Structured failure — status + parsed body, so callers can distinguish
 *  e.g. a 400 `MISSING_PRODUCT_ID` reject from a 503/network failure
 *  (afterSave must treat the latter as fire-and-forget, plan §4). */
export class CommerceClientError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(`commerce service request failed with status ${status}`);
		this.name = "CommerceClientError";
		this.status = status;
		this.body = body;
	}
}
