/**
 * Adapter-level entitlement failures.
 *
 * The port's own answers are deliberately not here: a grant is idempotent and
 * returns the recorded entitlement, and an unauthorized delivery is `false` by
 * port contract. What is left is the one condition the SQL answered with a
 * predicate that could not be omitted.
 */

/**
 * `check` was asked to authorize a delivery with **no scope** — neither an order
 * id nor a buyer reference.
 *
 * In SQL the scope was a `WHERE` clause, and a query with neither arm was
 * short-circuited to `false` by an explicit guard in the adapter. Here the same
 * call would otherwise mean "any active grant for this sku", which authorizes
 * every buyer of a digital product to download it — so the guard is kept, and made
 * LOUD rather than a silent `false`.
 *
 * Loud, because the two readings of a scopeless check are not equally likely. The
 * port's own type requires a sku and makes both scopes optional, so a scopeless
 * query is not a runtime condition a storefront can produce: it is a caller that
 * lost its session or its order id somewhere above and is about to serve a file on
 * the strength of a sku alone. Answering `false` hides that bug behind a refused
 * download; answering with a typed error names it. Both are fail-closed — nothing
 * is ever served on this path either way.
 */
export class EntitlementScopeRequiredError extends Error {
	override readonly name = "EntitlementScopeRequiredError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "ENTITLEMENT_SCOPE_REQUIRED";
	/** The sku the scopeless check named. */
	readonly sku: string;

	constructor(sku: string) {
		super(
			`an entitlement check for ${sku} carried neither an order id nor a buyer reference — ` +
				"delivery must be scoped to one of them, and a sku on its own would authorize every " +
				"buyer of that product",
		);
		this.sku = sku;
	}
}

/** Structural test for {@link EntitlementScopeRequiredError}. */
export function isEntitlementScopeRequiredError(
	err: unknown,
): err is EntitlementScopeRequiredError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ENTITLEMENT_SCOPE_REQUIRED"
	);
}
