import { type Cents, cents, type Currency } from "../money/cents.js";
import { CouponCurrencyMismatchError } from "./errors.js";
import { mulDivRoundHalfUp } from "./round.js";
import type { Coupon } from "./types.js";

/**
 * Coupon discount off the cart subtotal (Phase 6 §4), pure integer minor units.
 * Always returns a value in `[0, subtotal]`:
 *
 * - `fixed_amount`: `min(amountCents, subtotal)` — clamped so it never discounts
 *   past zero. Rejects a currency mismatch (§8 risk #7).
 * - `percentage`: `min(round_half_up(subtotal × bps / 10_000), capCents?, subtotal)`.
 *
 * The coupon is assumed already validated (dates, min-subtotal, exhaustion) by
 * the use-case; this function is only the arithmetic.
 */
export function computeCouponDiscount(
	subtotalCents: Cents,
	cartCurrency: Currency,
	coupon: Coupon,
): Cents {
	if (coupon.type === "fixed_amount") {
		if (coupon.currency !== cartCurrency) {
			throw new CouponCurrencyMismatchError(coupon.code, coupon.currency, cartCurrency);
		}
		return cents(Math.min(coupon.amountCents, subtotalCents));
	}

	// percentage
	if (!Number.isSafeInteger(coupon.bps) || coupon.bps < 0) {
		throw new RangeError(
			`percentage coupon requires a non-negative integer bps, got ${String(coupon.bps)}`,
		);
	}
	const raw = mulDivRoundHalfUp(subtotalCents, coupon.bps, 10_000);
	const capped = coupon.capCents === null ? raw : Math.min(raw, coupon.capCents);
	return cents(Math.min(capped, subtotalCents));
}
