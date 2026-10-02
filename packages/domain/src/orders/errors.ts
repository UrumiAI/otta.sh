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
	/** The submitted shipping address (ADR-0009) failed validation — a required
	 *  field (name/line1/city/postalCode/country) was empty, a field exceeded its
	 *  bound, or the country is not an ISO 3166-1 alpha-2 code (ADR-0021). */
	| "INVALID_SHIPPING_ADDRESS"
	// ADR-0021 — the zone is derived from the address:
	/** A cart with a physical line, in a store with zones, and no address. */
	| "MISSING_SHIPPING_ADDRESS"
	/** Zones exist and the address matches none of them ("we don't ship there"). */
	| "SHIPPING_ZONE_NOT_MATCHED"
	/** A non-blank region is not a real ISO 3166-2 subdivision of the country —
	 *  or, for a cart that ships, it is blank where the country has a
	 *  subdivision-level zone. */
	| "SHIPPING_REGION_CODE_REQUIRED"
	/** The chosen method does not belong to the zone the address matched. */
	| "SHIPPING_METHOD_NOT_IN_ZONE"
	/** The address matched a zone, and no method was chosen. */
	| "SHIPPING_METHOD_REQUIRED"
	/** A method was chosen for a cart with nothing to ship. */
	| "SHIPPING_METHOD_NOT_APPLICABLE"
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
	/**
	 * The gateway's `createIntent` was refused only because a request with the
	 * SAME key is still being processed (`PaymentIntentError.inFlight`) — a
	 * double-submitted checkout. Everything about the order is exactly as for
	 * `PAYMENT_INTENT_FAILED` (the pending row stays; a same-key retry re-issues
	 * the intent), but nothing failed: the right answer to the buyer is "busy,
	 * try again in a moment", which a retry then satisfies with the first
	 * request's intent.
	 */
	| "PAYMENT_INTENT_IN_FLIGHT"
	/**
	 * The `idempotencyKey` already names an order minted from a DIFFERENT cart
	 * (issue #133) — e.g. a stale or second tab submitting the old cart's
	 * `checkout:<cartId>` key while the cart cookie now names a new cart. A key
	 * is bound to the request it first carried: replaying it for another cart is
	 * not a replay, so it must never report that other order as this cart's
	 * success. Nothing is minted, adopted or flipped; the submitted cart stays
	 * `active`. The recovery is to reload checkout, which derives the key afresh.
	 */
	| "IDEMPOTENCY_KEY_REUSED"
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
	| "AMOUNT_MISMATCH"
	/**
	 * The confirmation's dedupe key (for x402, the on-chain `transaction`) is
	 * already recorded against a DIFFERENT order. One settlement consumes one
	 * on-chain payment, so this is never a redelivery to re-drive — it is the same
	 * receipt aimed at a second order, and it must be terminally refused before any
	 * state moves. Recorded as the `RECEIPT_REBOUND` anomaly.
	 */
	| "RECEIPT_REBOUND";
