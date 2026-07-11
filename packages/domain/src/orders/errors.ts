/**
 * Typed order/checkout failures (never status-code-as-logic, §7). The service
 * maps these to HTTP; the domain speaks only in these unions/errors.
 */

/** `createOrderFromCart` outcomes. */
export type CreateOrderFailure =
	| "CART_NOT_FOUND"
	| "CART_EMPTY"
	| "CART_CHECKED_OUT"
	| "RESERVATION_LOST"
	| "PRODUCT_NOT_PRICED"
	/** A line's `product_commerce` price currency ≠ the cart currency (review G5)
	 *  — summing it into the cart-currency total would mix monies. */
	| "CURRENCY_MISMATCH"
	// Phase 6 checkout-pipeline failures (shipping / tax / coupon):
	| "SHIPPING_METHOD_NOT_FOUND"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_FOUND"
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_MAX_PER_CUSTOMER"
	| "COUPON_CURRENCY_MISMATCH";

/** `settleOrder` outcomes (the confirmation path). */
export type SettleFailure =
	| "INVALID_SIGNATURE"
	| "UNKNOWN_EVENT"
	| "MALFORMED"
	| "ORDER_NOT_FOUND"
	| "AMOUNT_MISMATCH";
