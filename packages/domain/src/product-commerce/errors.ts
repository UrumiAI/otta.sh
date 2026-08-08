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
 * Domain error for a SKU RENAME that would land on an inventory row that
 * already exists. Raised by every `ProductCommerceStore` adapter from inside
 * the SAME transaction as the product-row write (`upsert` /
 * `updateCommerceFields` — see their port docs), so the refusal is atomic: the
 * rename is not applied and no stock moves.
 *
 * A rename CARRIES the sku's on-hand count forward, because an inventory row
 * is keyed by the natural key `sku`: without the carry the units would sit
 * under the old sku, referenced by nothing, while the product started again
 * from a fresh zero row. When the target sku ALREADY has a row of its own the
 * carry has no honest answer — merging two counts invents a single stock
 * figure the warehouse never agreed to, and picking a winner silently discards
 * the other — so the rename is refused instead and the operator decides.
 *
 * OCCUPIED IS OCCUPIED: the refusal does NOT depend on what the target row
 * holds. A row at `0` is still a row (a known sku that is out of stock, which
 * is a different fact from "no such sku"), and it may already be referenced by
 * reservations and order lines. Consequence, deliberate: a sku that has ever
 * held stock can never be renamed ONTO again — including undoing a rename,
 * since the source row is retained (at zero) rather than deleted.
 *
 * Both skus are named so an operator can act on the message without opening a
 * database.
 *
 * MAPPED AT THE HTTP BOUNDARY, beside `SkuConflictError`'s `SKU_TAKEN`: both
 * writers answer a structured 409 `SKU_STOCK_CONFLICT` carrying `fromSku` and
 * `toSku` — `reason` on the admin edit (`PATCH /admin/products/:id`), `error` on
 * the integrator upsert (`PUT /products/:id/commerce`), each in the envelope its
 * own route already uses. The message above stays inside the service: the two
 * skus are what crosses the wire, and the sentence an operator reads is composed
 * once in the admin plugin and rendered beside the SKU field it is about.
 */
export class SkuStockConflictError extends Error {
	/** The sku the product holds today — the one whose units would have moved. */
	readonly fromSku: string;
	/** The sku the rename asked for, which already has an inventory row. */
	readonly toSku: string;

	constructor(fromSku: string, toSku: string) {
		super(
			`cannot rename sku "${fromSku}" to "${toSku}": "${toSku}" already has its own inventory ` +
				"row, and stock is never merged between skus — rename to a sku that has never held " +
				`stock, or move "${toSku}"'s units elsewhere first`,
		);
		this.name = "SkuStockConflictError";
		this.fromSku = fromSku;
		this.toSku = toSku;
	}
}

/**
 * Domain error for a SKU RENAME whose SOURCE sku still has live reservations
 * against it. Raised by every `ProductCommerceStore` adapter from inside the
 * same transaction as the product-row write, exactly like
 * {@link SkuStockConflictError}: the rename is not applied and no stock moves.
 *
 * WHY A CARRY IS NOT ENOUGH WHILE A HOLD IS LIVE. The carry moves `on_hand` —
 * the AVAILABLE units — and a `held`/`adopted` reservation's units are already
 * OUT of that count, decremented when the hold was taken. The hold itself is
 * keyed by `reservations.sku`, which still names the OLD sku, and it cannot
 * follow the rename: `reservations.sku` references `inventory.sku`, so the row
 * can be neither re-keyed nor deleted. Every later transition on that hold
 * therefore lands on the source row the rename left behind and zeroed:
 *  - `release` / `releaseAdopted` (a cart expiring, an order failing) CREDITS
 *    the units back to the source sku — units that silently leave the product,
 *    reappearing under a sku nothing points at;
 *  - a downward `adjust` credits the same orphaned row;
 *  - an upward `adjust` decrements the SOURCE, which the rename just emptied,
 *    so a shopper enlarging a live cart line gets a spurious OUT_OF_STOCK while
 *    the product's real units sit under the new sku.
 * Carrying the holds instead was considered and rejected: it is a second
 * movement with its own races, and the standing pattern for a state the domain
 * cannot honestly reconcile is to refuse rather than pick a winner.
 *
 * So a rename waits for the holds to finish. They are all short-lived by
 * construction — a cart hold expires on its deadline and the sweep releases it,
 * an adopted hold commits or releases with its order — so this is a "try again
 * shortly", not a dead end, and the message says so. The sku and the number of
 * live holds are named so an operator can tell a busy product from a stuck one.
 *
 * MAPPED AT THE HTTP BOUNDARY, exactly like its sibling above: both writers
 * answer a structured 409 `SKU_HELD_STOCK` carrying the `sku` and the
 * `liveHolds` count, and the admin renders "this SKU has N reservations in
 * flight — try again shortly" beside the SKU field.
 */
export class SkuHeldStockError extends Error {
	/** The sku being renamed away from — the one the live holds still name. */
	readonly sku: string;
	/** How many `held`/`adopted` reservations still reference it. */
	readonly liveHolds: number;

	constructor(sku: string, liveHolds: number) {
		super(
			`cannot rename sku "${sku}": ${String(liveHolds)} live reservation(s) still reference it, ` +
				"and a reservation cannot follow a rename — its units would return to the old sku when " +
				"the cart or order finishes. Retry once the holds are committed, released, or expired",
		);
		this.name = "SkuHeldStockError";
		this.sku = sku;
		this.liveHolds = liveHolds;
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
