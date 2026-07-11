import type { IdempotencyKey, OrderId, ProductId, Sku } from "../money/ids.js";

/** Entitlement lifecycle (§6). */
export type EntitlementState = "active" | "revoked";

/** How an entitlement was granted (§6). */
export type EntitlementSource = "order_paid" | "x402";

export interface Entitlement {
	id: string;
	orderId: OrderId;
	productId: ProductId | null;
	sku: Sku;
	/** Email/session claim token; Phase 5 re-keys to a customer id (§6). */
	buyerRef: string;
	state: EntitlementState;
	source: EntitlementSource;
	grantedAt: string;
}

export interface GrantEntitlementInput {
	orderId: OrderId;
	productId: ProductId | null;
	sku: Sku;
	buyerRef: string;
	source: EntitlementSource;
	/** UNIQUE grant-once key (§6): a webhook/proof replay re-grants nothing. */
	grantIdempotencyKey: IdempotencyKey;
}

/** Delivery-authorization query: keyed on order OR buyer (both scope to a sku). */
export interface EntitlementQuery {
	orderId?: OrderId;
	buyerRef?: string;
	sku: Sku;
}

/**
 * The `EntitlementStore` port (Phase 4 §6). Shared machinery for both
 * digital-via-Stripe and x402. Grant is idempotent under `grantIdempotencyKey`
 * UNIQUE; check authorizes delivery — the file is never served without an active
 * row.
 */
export interface EntitlementStore {
	/** Grant-once (idempotent on `grantIdempotencyKey`); returns the (new or
	 *  existing) entitlement. */
	grant(input: GrantEntitlementInput): Promise<Entitlement>;
	/** True iff an `active` entitlement matches the query (order/buyer + sku). */
	check(query: EntitlementQuery): Promise<boolean>;
}
