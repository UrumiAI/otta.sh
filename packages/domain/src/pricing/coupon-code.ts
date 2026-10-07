/**
 * The coupon CODE's identity rules and the two refusals a `CouponStore.create`
 * owes every caller — declared once, here on the port's side, so every adapter
 * throws the same structural error and a caller maps it without importing an
 * adapter (ADR-0025).
 *
 * WHY THESE LIVE IN THE DOMAIN. The document store raised its own
 * `CouponCodeConflictError` while the in-memory store threw a bare `Error` (and
 * silently overwrote a duplicate id), so the contract could only assert "it
 * rejects" and the plugin's client had to import the document store's error
 * types to answer a duplicate as a refusal. Both are port behaviour, not an
 * adapter's detail.
 */

/**
 * The case-folded form a code is unique under and looked up by (ADR-0025). ONE
 * function for every adapter, so "the same code" cannot mean two things.
 *
 * `toLowerCase()` is locale-independent in JS, and new codes are printable ASCII
 * (the admin surface refuses anything else), where it is an exact case fold. A
 * code minted before that rule with non-ASCII letters folds by the same
 * function on every path, so it stays reachable — just not under every
 * Unicode-equivalent spelling.
 */
export function foldCouponCode(code: string): string {
	return code.toLowerCase();
}

/** `create` was handed a code a LIVE coupon already holds, compared folded. */
export class CouponCodeConflictError extends Error {
	override readonly name = "CouponCodeConflictError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "COUPON_CODE_CONFLICT";
	readonly couponCode: string;
	readonly heldBy: string;

	constructor(couponCode: string, heldBy: string) {
		super(
			`coupon code ${couponCode} is already claimed by coupon ${heldBy} — ` +
				"a code identifies one promotion, and an issued one is never re-defined",
		);
		this.couponCode = couponCode;
		this.heldBy = heldBy;
	}
}

/**
 * `create` was handed a coupon id that already exists. Returning the existing
 * coupon would hand this caller somebody else's promotion, economics and
 * counter, so it is an error rather than an adoption.
 */
export class CouponIdCollisionError extends Error {
	override readonly name = "CouponIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "COUPON_ID_COLLISION";
	readonly couponId: string;

	constructor(couponId: string) {
		super(
			`coupon ${couponId} already exists — the existing coupon was NOT adopted, ` +
				"because its economics and its use counter are not this caller's",
		);
		this.couponId = couponId;
	}
}

/** Structural test for {@link CouponCodeConflictError}. */
export function isCouponCodeConflictError(err: unknown): err is CouponCodeConflictError {
	return hasCode(err, "COUPON_CODE_CONFLICT");
}

/** Structural test for {@link CouponIdCollisionError}. */
export function isCouponIdCollisionError(err: unknown): err is CouponIdCollisionError {
	return hasCode(err, "COUPON_ID_COLLISION");
}

function hasCode(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
