/**
 * The coupon adapter's own errors — conditions the SQL adapter left to a database
 * constraint, which a document store has to raise itself.
 *
 * All three are LOUD on purpose. Each replaces a `NOT NULL`/foreign-key/primary-key
 * violation that would have aborted a transaction, and none of them is a runtime
 * condition a caller is expected to handle: the port's result types have no member
 * for "that coupon does not exist" or "that code is taken", because the SQL adapter
 * had none either.
 */

/**
 * `redeem` was handed a coupon id with no document.
 *
 * The SQL insert would have failed `coupon_redemptions.coupon_id`'s foreign key and
 * rolled the transaction back, so the caller saw a throw. Here the coupon document
 * is read BEFORE any write, so nothing is claimed and nothing is counted — which is
 * also what keeps a delete racing a redeem from leaving a redemption behind on a
 * coupon that is gone.
 */
export class CouponNotFoundError extends Error {
	override readonly name = "CouponNotFoundError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "COUPON_NOT_FOUND";
	readonly couponId: string;

	constructor(couponId: string) {
		super(`coupon ${couponId} has no document — nothing was claimed and no counter moved`);
		this.couponId = couponId;
	}
}

/**
 * `create` was handed a code another LIVE coupon already holds.
 *
 * `coupons.code` was UNIQUE in SQL. Here the claim document `coupon_codes/{folded}`
 * is the enforcement, and a claim whose owning coupon no longer exists is taken
 * over rather than treated as a conflict — so a crash between deleting a coupon and
 * releasing its code does not strand the code forever.
 *
 * Codes are unique after CASE FOLDING here, where SQL's unique index was
 * case-sensitive. That is the narrower rule, and it is the one the admin list's
 * case-insensitive exact search already implies.
 */
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
 * `create` was handed a coupon id that already has a document.
 *
 * The primary key on `coupons.id` raised this in SQL. Returning the existing
 * coupon instead would silently hand this caller somebody else's promotion, with
 * somebody else's economics and counter, so it is an error rather than an adoption.
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

/** Structural test for {@link CouponNotFoundError}. */
export function isCouponNotFoundError(err: unknown): err is CouponNotFoundError {
	return isCoded(err, "COUPON_NOT_FOUND");
}

/** Structural test for {@link CouponCodeConflictError}. */
export function isCouponCodeConflictError(err: unknown): err is CouponCodeConflictError {
	return isCoded(err, "COUPON_CODE_CONFLICT");
}

/** Structural test for {@link CouponIdCollisionError}. */
export function isCouponIdCollisionError(err: unknown): err is CouponIdCollisionError {
	return isCoded(err, "COUPON_ID_COLLISION");
}

function isCoded(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
