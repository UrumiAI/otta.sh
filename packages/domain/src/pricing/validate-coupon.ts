import type { Cents, Currency } from "../money/cents.js";
import type { CouponRecord } from "../ports/coupon-store.js";
import type { Coupon } from "./types.js";

export type CouponValidationFailure =
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_CURRENCY_MISMATCH";

export type ValidateCouponResult =
	| { ok: true; coupon: Coupon }
	| { ok: false; reason: CouponValidationFailure };

export interface CouponValidationContext {
	/** ISO-8601 UTC `now` from the use-case's clock (never read inside the pure math). */
	now: string;
	subtotalCents: Cents;
	currency: Currency;
}

/**
 * Validate a loaded coupon record against the checkout context (Phase 6 §5) and,
 * if valid, project it to the pure `Coupon` data the engine consumes. Pure — the
 * caller supplies `now` from its clock. The exhaustion check here is a soft
 * pre-check for a clean preview/error; the ATOMIC guard is `CouponStore.redeem`
 * (§5), which is what actually prevents over-redemption under concurrency.
 */
export function validateCoupon(
	record: CouponRecord,
	ctx: CouponValidationContext,
): ValidateCouponResult {
	// Date window: [startsAt, expiresAt). Null bounds are open.
	if (record.startsAt !== null && ctx.now < record.startsAt) {
		return { ok: false, reason: "COUPON_NOT_ACTIVE" };
	}
	if (record.expiresAt !== null && ctx.now >= record.expiresAt) {
		return { ok: false, reason: "COUPON_NOT_ACTIVE" };
	}
	if (record.minSubtotalCents !== null && ctx.subtotalCents < record.minSubtotalCents) {
		return { ok: false, reason: "COUPON_MIN_SUBTOTAL" };
	}
	if (record.maxUses !== null && record.usesCount >= record.maxUses) {
		return { ok: false, reason: "COUPON_EXHAUSTED" };
	}

	if (record.type === "fixed_amount") {
		if (record.amountCents === null || record.currency === null) {
			throw new Error(`fixed_amount coupon ${record.code} is missing amount/currency`);
		}
		if (record.currency !== ctx.currency) {
			return { ok: false, reason: "COUPON_CURRENCY_MISMATCH" };
		}
		return {
			ok: true,
			coupon: {
				type: "fixed_amount",
				code: record.code,
				amountCents: record.amountCents,
				currency: record.currency,
			},
		};
	}

	// percentage
	if (record.rateBps === null) {
		throw new Error(`percentage coupon ${record.code} is missing rateBps`);
	}
	return {
		ok: true,
		coupon: {
			type: "percentage",
			code: record.code,
			bps: record.rateBps,
			capCents: record.capCents,
		},
	};
}
