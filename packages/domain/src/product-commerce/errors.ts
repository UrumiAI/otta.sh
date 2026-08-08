/**
 * Domain error for the "create then price" invariant (Phase 1 §1 case 3 / §5).
 * A commercial upsert with a missing/empty `product_id` is rejected before any
 * row is minted — enforced at every `ProductCommerceStore` adapter (fake,
 * Kysely) and mapped to HTTP 400 by `@otta-sh/service`.
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
 * by `@otta-sh/service` — never an opaque 500.
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
 * HTTP 400 by `@otta-sh/service`. Defense-in-depth alongside the service's zod
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

/**
 * Domain validation error for `ProductListFilter.lowStockThreshold` (the
 * admin Products list/count low-stock predicate). The port's declared domain
 * is a NON-NEGATIVE INTEGER — the only domain every adapter agrees on, and
 * the same domain the HTTP boundary already validates to
 * (`packages/service/src/schemas.ts`'s `lowStockQuery`/`settingsBody`:
 * `z.number().int().nonnegative()`). Outside that domain the raw adapters
 * silently DISAGREE, which is exactly what this error exists to prevent:
 * measured, a fractional threshold (e.g. `2.5`) filters cleanly in the fake
 * and SQLite but Postgres rejects it binding an `integer` column
 * ("invalid input syntax for type integer"); a `NaN` threshold returns
 * EVERY stocked row in a naive fake (`onHand > NaN` is always false, so
 * nothing is excluded), returns NONE in SQLite, and throws in Postgres —
 * three answers to one input. Every `ProductCommerceStore` adapter (the
 * fake, the Kysely store on both dialects) therefore validates the
 * threshold FIRST, via the shared `isValidLowStockThreshold` guard, and
 * throws this SAME error before any comparison or query runs — contract-
 * pinned (`product-commerce-store-contract.ts`) so the three can never
 * drift apart again.
 *
 * THE CEILING IS PART OF THE DOMAIN, for the same reason and by the same
 * measurement. `inventory.on_hand` is a Postgres `integer`, and the predicate
 * binds the threshold straight into `on_hand <= $1`: a value above
 * {@link MAX_LOW_STOCK_THRESHOLD} is out of range for `int4`, so Postgres
 * throws while better-sqlite3 and the fake accept it and answer — the SAME
 * three-way disagreement, one bound higher up. Unbounded, it arrives as a 500
 * through the very catch that exists to turn a bad threshold into a 400.
 */
export class InvalidLowStockThresholdError extends Error {
	readonly value: number;

	constructor(value: number) {
		super(
			`lowStockThreshold must be a non-negative integer no greater than ${String(
				MAX_LOW_STOCK_THRESHOLD,
			)}, got ${String(value)}`,
		);
		this.name = "InvalidLowStockThresholdError";
		this.value = value;
	}
}

/**
 * The largest threshold every adapter can answer identically: `int4`'s
 * maximum, because `inventory.on_hand` is a Postgres `integer` and the
 * threshold is bound against it. A stock count cannot exceed the column that
 * holds it, so nothing is lost by refusing above it — and everything is lost
 * by allowing it, since only one of the three adapters fails.
 */
export const MAX_LOW_STOCK_THRESHOLD = 2_147_483_647;

/**
 * The domain guard `InvalidLowStockThresholdError` enforces: a finite,
 * non-negative integer no greater than {@link MAX_LOW_STOCK_THRESHOLD}.
 * Exported so every adapter shares ONE definition instead of re-deriving
 * `Number.isInteger` checks that could quietly drift apart from each other
 * (the exact failure `InvalidLowStockThresholdError`'s doc records).
 * `Number.isInteger` is `false` for `NaN`/`±Infinity`/any fractional value, so
 * those are rejected without a separate finiteness check.
 */
export function isValidLowStockThreshold(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= MAX_LOW_STOCK_THRESHOLD;
}
