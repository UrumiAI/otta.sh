/** Pricing-engine input-validation errors (Phase 6 §8 risk #7). */

import type { Currency } from "../money/cents.js";

/**
 * A `fixed_amount` coupon carries a fixed `currency`; applying it to a cart in a
 * different currency is money-mixing, rejected at `computeCouponDiscount` input
 * validation (§8 risk #7). Percentage coupons are currency-agnostic and never
 * raise this.
 */
export class CouponCurrencyMismatchError extends Error {
	constructor(couponCode: string, couponCurrency: Currency, cartCurrency: Currency) {
		super(
			`coupon ${couponCode} is denominated in ${couponCurrency} but the cart is ${cartCurrency} — ` +
				"a fixed-amount coupon cannot cross currencies",
		);
		this.name = "CouponCurrencyMismatchError";
	}
}
