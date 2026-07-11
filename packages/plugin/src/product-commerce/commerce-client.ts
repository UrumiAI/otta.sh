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
	/** The publish gate: the join derives purchasability from it
	 *  (`purchasable ⟺ present && active`). */
	active: boolean;
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
	/** The afterPublish→activate follow-up (plan §6 step 7): mirrors
	 *  `POST /products/:id/commerce/activate` 1:1. Deliberately separate from
	 *  `upsertProductCommerce` — see the service route's doc for why `active`
	 *  is not an upsert field. `contentUpdatedAt` is the CMS content's
	 *  `updatedAt` at publish time — the ordering watermark the store gates on
	 *  so a stale, out-of-order publish is a no-op (convergence). */
	activateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;
	/** The afterUnpublish→deactivate follow-up (plan §6 step 7): the mirror of
	 *  `activateProductCommerce`, mirrors `POST /products/:id/commerce/deactivate`
	 *  1:1 — closes the publish gate so an unpublished product stops being
	 *  purchasable. `contentUpdatedAt` is the same ordering watermark. */
	deactivateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;

	// ── Phase 2: catalog batch read (plan §6) ─────────────────────────────
	// (A later Phase-3 task adds its cart methods below this block — keep
	// the delimiters so the diff surfaces stay additive.)
	getCommerceBatch(productIds: string[]): Promise<ProductCommerceBatchItem[]>;
	// ── end Phase 2 catalog batch read ────────────────────────────────────

	// ── Phase 3 group E: cart (plan §6, wire mirrors @urumi/service's ─────
	// `/carts` routes 1:1, hand-rolled like the wire types above — the
	// plugin declares no runtime dependency on @urumi/domain/service). ────
	createCart(currency?: string): Promise<{ cartId: string }>;
	getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>>;
	addCartLine(
		cartId: string,
		sku: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>>;
	adjustCartLine(
		cartId: string,
		lineId: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>>;
	removeCartLine(
		cartId: string,
		lineId: string,
		idempotencyKey: string,
	): Promise<CartResult<Record<string, never>>>;
	// ── end Phase 3 group E: cart ─────────────────────────────────────────
}

// ── Phase 3 group E: cart wire types (plan §6) ─────────────────────────────
// Mirror `@urumi/service`'s `routes/carts.ts` serialization 1:1: NO price
// field on a line (a cart line snapshots no price — domain `CartStore`'s own
// documented invariant; the live price is read from `product_commerce`
// elsewhere, at display/checkout, never stored on the line).
export interface CartLineWire {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
}

export interface CartWire {
	cartId: string;
	state: string;
	currency: string;
	lines: CartLineWire[];
}

/**
 * Typed cart-mutation failures — SEMANTIC TOKENS, never English (matches
 * Phase 2's `AvailabilityToken` pattern): `@urumi/service`'s `CartFailure`
 * union verbatim (adapter-architecture rule #2, "no status-code-as-logic" —
 * `OUT_OF_STOCK` rides a 200, `CART_NOT_FOUND`/`LINE_NOT_FOUND` a 404,
 * `CART_CHECKED_OUT`/`LINE_CHECKED_OUT`/`HOLD_EXPIRED` a 409 — the CLIENT
 * normalizes all of these back to a uniform `{ ok: false; reason }` value,
 * see `HttpCommerceClient`'s `#cartResult`, so callers branch on the token,
 * never the HTTP status).
 */
export type CartFailureReason =
	| "OUT_OF_STOCK"
	| "CART_NOT_FOUND"
	| "LINE_NOT_FOUND"
	| "CART_CHECKED_OUT"
	| "LINE_CHECKED_OUT"
	| "HOLD_EXPIRED";

export type CartResult<T> = ({ ok: true } & T) | { ok: false; reason: CartFailureReason };
// ── end Phase 3 group E: cart wire types ───────────────────────────────────

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
