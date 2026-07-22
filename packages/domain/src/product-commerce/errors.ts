/**
 * Domain error for the "create then price" invariant (Phase 1 §1 case 3 / §5).
 * A commercial upsert with a missing/empty `product_id` is rejected before any
 * row is minted — enforced at every `ProductCommerceStore` adapter (fake,
 * Kysely) and mapped to HTTP 400 by `@urumi/service`.
 */
export class MissingProductIdError extends Error {
	constructor() {
		super("product_id is required");
		this.name = "MissingProductIdError";
	}
}

/**
 * Domain error for a live-SKU uniqueness conflict (review F2): a merchant
 * assigning a SKU another LIVE (non-deleted) product already holds — the
 * most likely real merchant input error. Raised by every
 * `ProductCommerceStore` adapter (the fake's live-sku check; the Kysely
 * store's narrowly-scoped catch of the `product_commerce_live_sku_unique`
 * partial-index violation) and mapped to a structured HTTP 409 `SKU_TAKEN`
 * by `@urumi/service` — never an opaque 500.
 */
export class SkuConflictError extends Error {
	readonly sku: string;

	constructor(sku: string) {
		super(`sku "${sku}" is already used by another live product`);
		this.name = "SkuConflictError";
		this.sku = sku;
	}
}

/**
 * Domain validation error for a standalone product EDIT (admin-UX Increment 2,
 * slice 2): a field the merchant supplied is out of the domain's bounds — a
 * price that is not strictly positive, or a negative weight/dimension. Thrown
 * by `updateProductCommerceFields` BEFORE the guarded store write, mapped to
 * HTTP 400 by `@urumi/service`. Defense-in-depth alongside the service's zod
 * layer and the plugin's per-field validation; branded `Cents` already rejects
 * a float/negative/non-safe-integer price at the type + `cents()` boundary, so
 * this guard's job is the domain rule those layers cannot express: price > 0.
 * `field` names the offending input so the boundary can render it per-field.
 */
export class InvalidProductFieldError extends Error {
	readonly field: string;

	constructor(field: string, message: string) {
		super(message);
		this.name = "InvalidProductFieldError";
		this.field = field;
	}
}
