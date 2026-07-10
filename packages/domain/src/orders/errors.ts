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
	| "PRODUCT_NOT_PRICED";

/** `settleOrder` outcomes (the confirmation path). */
export type SettleFailure =
	| "INVALID_SIGNATURE"
	| "UNKNOWN_EVENT"
	| "MALFORMED"
	| "ORDER_NOT_FOUND"
	| "AMOUNT_MISMATCH";
