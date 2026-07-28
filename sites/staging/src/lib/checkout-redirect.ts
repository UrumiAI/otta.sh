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
import type { CheckoutSummaryRouteResult } from "@urumi/plugin";
import { SERVICE_UNAVAILABLE } from "./cart-actions.js";

export interface CheckoutRedirect {
	path: string;
	/** The `?error=` token, when there is something to explain. Absent for the
	 *  plain "you have no cart" case — nothing went wrong there. */
	error?: string;
}

/**
 * @param cartId the `urumi_cart` cookie's value, if any
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
	if (result.ok) return null;

	// Typed reason (CART_EMPTY / CART_NOT_FOUND / PRODUCT_NOT_PRICED /
	// CURRENCY_MISMATCH / …) or a route-level error token — either way the buyer
	// cannot check out, and `/cart` is where they can do something about it.
	return { path: "/cart", error: "reason" in result ? result.reason : result.error };
}
