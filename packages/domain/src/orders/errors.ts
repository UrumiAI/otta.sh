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
	/** The submitted shipping address (ADR-0009) failed shape validation — a
	 *  required field (name/line1/city/postalCode/country) was empty, or a field
	 *  exceeded its bound. NOT the "physical order requires an address" rule: that
	 *  enforcement is deferred until the storefront UI collects it (ADR-0009
	 *  sequencing), so this slice ships capture-optional. */
	| "INVALID_SHIPPING_ADDRESS"
	/**
	 * The gateway's `createIntent` failed (a live provider call refused or could
	 * not be reached — a thrown `PaymentIntentError`). The `pending` order row
	 * **stays**, deliberately: it carries `holdExpiresAt`, so `expireOrders`
	 * sweeps it at TTL (releasing the reservations AND the coupon), while a
	 * same-key retry short-circuits on the idempotency key and re-issues the
	 * intent against the SAME order — which the provider's own idempotency key
	 * dedupes. The service maps this to 502 (a bad upstream, not a bad request).
	 */
	| "PAYMENT_INTENT_FAILED"
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
