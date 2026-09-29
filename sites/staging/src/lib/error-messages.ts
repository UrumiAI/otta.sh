/**
 * Friendly copy for the `?error=<TOKEN>` shoppers can land on (item 2 —
 * raw error tokens shown to shoppers). Every `failureToken`/route result the
 * `/cart/*` endpoints and the PDP page can currently put on the query string
 * — the plugin's own (`OUT_OF_STOCK`, `CART_NOT_FOUND`, …), the site's own
 * (`SERVICE_UNAVAILABLE`, `cart-actions.ts`), and item 3's new
 * (`PRODUCT_NOT_FOUND`/`PRODUCT_UNAVAILABLE`) — maps to a human sentence
 * here. The raw token STAYS in the URL (`?error=OUT_OF_STOCK`) and in
 * `console.error` logs for debugging; only the on-page text changes.
 *
 * `MESSAGES` is a `Record<string, string>` with a generic fallback for any
 * unmapped/future token — defense in depth, so a raw machine token is never
 * rendered even if a new one is introduced later and someone forgets this
 * file.
 */
import type { CheckoutFailureReason } from "@otta-sh/plugin";

const GENERIC_FALLBACK = "Something went wrong — please try again shortly.";

/**
 * #305 part 1 — the buyer's selection, refused at the summary or at place.
 * Derived from the plugin's wire union with `Extract<>` and checked with
 * `satisfies`, so a coupon or shipping reason added to the plugin without copy
 * here fails the type check (`CheckoutFailureReason` is the wider union: it
 * also carries the place-only `COUPON_MAX_PER_CUSTOMER`).
 *
 * No copy promises a refund: no order is minted before the coupon and the
 * method are checked, so nothing was charged.
 */
const SELECTION_MESSAGES = {
	COUPON_NOT_FOUND:
		"We couldn't find that coupon code — check it and try again (codes are case-sensitive).",
	COUPON_NOT_ACTIVE: "That coupon isn't active right now — it may have expired or not started yet.",
	COUPON_MIN_SUBTOTAL: "Your order doesn't reach that coupon's minimum spend yet.",
	COUPON_EXHAUSTED: "That coupon has reached its usage limit.",
	// Unreachable today (no customer id is passed at checkout), but in the union.
	COUPON_MAX_PER_CUSTOMER: "You've already used that coupon as many times as it allows.",
	COUPON_CURRENCY_MISMATCH: "That coupon can't be used with this store's currency.",
	SHIPPING_METHOD_NOT_FOUND: "That delivery option is no longer available — please choose another.",
	SHIPPING_RATE_NOT_FOUND: "That delivery option isn't available for this order's currency.",
	// #305 part 2 (ADR-0021): the zone is derived from the address.
	SHIPPING_ZONE_NOT_MATCHED: "We don't ship to this address.",
	// Neutral about delivery: the site shows it only for a cart that ships (a
	// digital-only review has no address block), but the words stay true for
	// an API caller's digital order with a bad region too.
	SHIPPING_REGION_CODE_REQUIRED:
		"Enter your state/province code (e.g. CA), or leave it blank if your country doesn't use one.",
	SHIPPING_METHOD_NOT_IN_ZONE: "Delivery options changed for your address — please choose again.",
	SHIPPING_METHOD_REQUIRED: "There are no delivery options for this address.",
	// For API callers: no page of this site sends a method for a cart with
	// nothing to ship (the summary drops a stale one silently).
	SHIPPING_METHOD_NOT_APPLICABLE: "Your order doesn't need delivery.",
} satisfies Record<
	Extract<CheckoutFailureReason, `COUPON_${string}` | `SHIPPING_${string}`>,
	string
>;

const MESSAGES: Record<string, string> = {
	OUT_OF_STOCK: "Sorry, that item is out of stock.",
	CART_NOT_FOUND: "Your cart could not be found — it may have expired.",
	LINE_NOT_FOUND: "That cart item could not be found — it may have already been removed.",
	CART_CHECKED_OUT: "This cart has already been checked out.",
	LINE_CHECKED_OUT: "That item has already been checked out.",
	HOLD_EXPIRED: "Your hold on that item expired — please try again.",
	SKU_MISMATCH: "That item could not be added — please refresh the page and try again.",
	// The INVALID_*/RENDER_FAILED/SERVICE_UNAVAILABLE cluster: none of these
	// are shopper-actionable specifics, so they share the generic copy.
	INVALID_INPUT: GENERIC_FALLBACK,
	INVALID_CART_ID: GENERIC_FALLBACK,
	INVALID_CURRENCY: GENERIC_FALLBACK,
	RENDER_FAILED: GENERIC_FALLBACK,
	SERVICE_UNAVAILABLE: GENERIC_FALLBACK,
	// Item 3 — bogus SKU/productId rejection tokens (cart-actions.ts).
	PRODUCT_NOT_FOUND: "That product couldn't be found — please refresh the page and try again.",
	PRODUCT_UNAVAILABLE: "That product couldn't be found — please refresh the page and try again.",
	// ── Checkout (storefront-checkout plan §1.7) ────────────────────────────
	CART_EMPTY: "Your cart is empty — add something before checking out.",
	// The 15-minute hold lapsed, or stock moved between the quote and the order.
	// Not the buyer's fault, and not a dead end: the cart is still there.
	RESERVATION_LOST:
		"Your hold on one or more items expired before payment completed — please review your cart and try again.",
	// Quoted from §1.7 rather than paraphrased, and shared by both reasons: from
	// the buyer's side an unpriced product and a currency mismatch are the same
	// fact — this cannot be bought right now.
	PRODUCT_NOT_PRICED: "One of the items in your cart is no longer available for purchase.",
	CURRENCY_MISMATCH: "One of the items in your cart is no longer available for purchase.",
	// The UPSTREAM gateway failed (Stripe down/rejecting, or an unsupported
	// currency — indistinguishable at the page, and the copy is true either
	// way). "No charge was made" is the one fact the buyer needs. Deliberately
	// does NOT tell them to start a new cart: the pending order is kept on
	// purpose and expire-orders sweeps it at TTL.
	PAYMENT_INTENT_FAILED:
		"We couldn't start a payment for this order. No charge was made — please try again in a moment.",
	// Issue #133: a stale/second tab placed with the key of a cart that was
	// already ordered. The redirect back to /checkout re-renders the form with
	// the CURRENT cart's key, so placing again simply works.
	IDEMPOTENCY_KEY_REUSED:
		"This checkout page was out of date — please review your order and place it again.",
	INVALID_SHIPPING_ADDRESS:
		"Please check the delivery address — some fields are missing or too long.",
	MISSING_SHIPPING_ADDRESS: "Enter your delivery address to continue.",
	INVALID_EMAIL: "That doesn't look like a valid email address — please check it and try again.",
	ORDER_NOT_FOUND: "That order could not be found — please check the link you followed.",
	// The store has not connected Stripe. Honest about WHOSE problem it is.
	STRIPE_NOT_CONFIGURED: "Card payment isn't set up on this store yet.",
	...SELECTION_MESSAGES,
	// ── Customer account (issue #306, ADR-0004) ─────────────────────────────
	// A failed magic link. Each says what to do next, and none says anything
	// about whether an account exists.
	LOGIN_LINK_USED: "That sign-in link has already been used — request a new one below.",
	LOGIN_LINK_EXPIRED: "That sign-in link has expired — request a new one below.",
	LOGIN_LINK_INVALID: "That sign-in link isn't valid — request a new one below.",
};

/** Never returns the raw token, `undefined`, or an empty string — an
 *  unrecognized token (including `""`) falls back to the generic copy. */
export function cartErrorMessage(token: string): string {
	return MESSAGES[token] ?? GENERIC_FALLBACK;
}
