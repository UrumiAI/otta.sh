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
 * `create`'s two refusals — a code another LIVE coupon holds (compared folded:
 * the claim document `coupon_codes/{folded}` is the enforcement, and a claim whose
 * owning coupon no longer exists is taken over, so a crash between deleting a
 * coupon and releasing its code does not strand the code), and an id that already
 * has a document — are PORT behaviour and live in `@otta-sh/domain` (ADR-0025).
 * Re-exported here under their old names so existing imports keep working.
 */
export {
	CouponCodeConflictError,
	CouponIdCollisionError,
	isCouponCodeConflictError,
	isCouponIdCollisionError,
} from "@otta-sh/domain";

/** Structural test for {@link CouponNotFoundError}. */
export function isCouponNotFoundError(err: unknown): err is CouponNotFoundError {
	return isCoded(err, "COUPON_NOT_FOUND");
}

function isCoded(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
