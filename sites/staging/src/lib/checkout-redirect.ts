/**
 * `GET /checkout`'s entry guard — the one decision the review page makes before
 * it renders anything.
 *
 * It lives here, not inline in `index.astro`, because `.astro` files have no
 * render harness in this package (issue #40) and this rule is exactly the kind
 * that must not drift: §1.7's "**303 to `/cart`** — never render an empty
 * checkout with a payable-looking button". A page that renders a total and a
 * "Continue to payment" button over a cart that cannot be ordered is worse than
 * an error; it invites the buyer to try, and the failure lands after they have
 * entered their email.
 *
 * Every non-renderable state goes to `/cart` carrying its token, so the cart
 * page — which the buyer can act on — explains it. That includes the ordinary
 * case this guard exists for: a buyer landing on `/checkout` with no cart at
 * all, which is far more common than the place-time race.
 */
import type { CheckoutSummaryRouteResult } from "@urumi.ai/otta-plugin";
import { SERVICE_UNAVAILABLE } from "./cart-actions.js";

export interface CheckoutRedirect {
	path: string;
	/** The `?error=` token, when there is something to explain. Absent for the
	 *  plain "you have no cart" case — nothing went wrong there. */
	error?: string;
}

/**
 * @param cartId the `otta_cart` cookie's value, if any
 * @param result the `storefront/checkout/summary` result — `null` when the
 *   dispatch itself failed (a stopped commerce service is an expected staging
 *   condition, never a crash)
 * @returns where to send the buyer instead, or `null` to render the page
 */
export function checkoutEntryRedirect(
	cartId: string | undefined,
	result: CheckoutSummaryRouteResult | null,
): CheckoutRedirect | null {
	// No cart at all: not an error, just nothing to check out. The summary route
	// is never even called.
	if (cartId === undefined || cartId.length === 0) return { path: "/cart" };

	if (result === null) return { path: "/cart", error: SERVICE_UNAVAILABLE };
	if (result.ok) {
		// The cart already became an order that is PAID (or later, or in a state
		// this build does not know): the confirmation page reads its real state and
		// is the only honest place for the buyer. A pending order renders the locked
		// review; an ended one renders "start a new cart" — both on this page.
		if (result.orderCreated && result.order.phase === "placed") {
			return { path: `/orders/${encodeURIComponent(result.order.id)}` };
		}
		// Rendered — including a summary that carries `selectionErrors`: a refused
		// coupon is a notice beside the undiscounted totals, never a bounce.
		return null;
	}

	// Typed reason (CART_EMPTY / CART_NOT_FOUND / PRODUCT_NOT_PRICED /
	// CURRENCY_MISMATCH / …) or a route-level error token — either way the buyer
	// cannot check out, and `/cart` is where they can do something about it.
	return { path: "/cart", error: "reason" in result ? result.reason : result.error };
}

/**
 * Whether the summary says the `otta_cart` cookie names no cart, so the page
 * drops it as the cart's write shims do (`BAD_CART_COOKIE_TOKENS`, #447) — and a
 * tampered or expired cookie stops landing the shopper on the same refusal
 * (#610). Not the summary's `INVALID_INPUT`: this page also dispatches the
 * URL's coupon, destination and method, and a hand-edited query string must
 * never cost the shopper their cart.
 */
export function checkoutDropsCartCookie(result: CheckoutSummaryRouteResult | null): boolean {
	if (result === null || result.ok) return false;
	// `INVALID_CART_ID` is the cart READ's answer, listed (as there) so a summary
	// that ever starts giving it drops the cookie too.
	const token: string = "reason" in result ? result.reason : result.error;
	return token === "CART_NOT_FOUND" || token === "INVALID_CART_ID";
}
