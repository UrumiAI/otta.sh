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
