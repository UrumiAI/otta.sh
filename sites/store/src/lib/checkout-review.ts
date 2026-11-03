/**
 * Decisions the `/checkout` review page makes about what it prints — kept here,
 * beside their tests, because `.astro` pages have no render harness in this
 * package.
 */

import type { CheckoutStash } from "./checkout-cookie.js";

/** The site's own token: place found this cart's order already placed (another
 *  tab) with an email other than the one typed (QA2 X2). */
export const ORDER_PLACED_OTHER_EMAIL = "ORDER_PLACED_OTHER_EMAIL";

/**
 * The `?error=` the review may show. Once the cart has become an order the
 * review is LOCKED to it, and a place-time refusal in the URL (an invalid email,
 * a stale page, a coupon) describes a form that is no longer on the page —
 * typically the history entry Back returns to from the pay page. Showing it over
 * a locked order would explain a mistake the buyer can no longer make, so the
 * locked review shows none.
 */
export function reviewErrorToken(error: string | null, locked: boolean): string | null {
	if (error === null || error.length === 0) return null;
	return locked ? null : error;
}

/**
 * What the LOCKED review says (under the lead "This order was already placed.")
 * when place found the order already placed — by
 * another tab or window — with another email (QA2 X2). The one place-time token a
 * locked review does show: it is ABOUT the locked order. The address is the
 * order's masked email from the checkout stash place just wrote, and only when
 * that stash is this order's; without one the sentence names no address rather
 * than a wrong one.
 */
export function lockedOtherEmailNotice(
	error: string | null,
	locked: { id: string } | null,
	stash: CheckoutStash | null,
): string | null {
	if (error !== ORDER_PLACED_OTHER_EMAIL || locked === null) return null;
	const hint = stash !== null && stash.orderId === locked.id ? stash.emailHint : undefined;
	const placedWith = hint !== undefined ? `with ${hint}` : "with a different email";
	return `It was placed in another tab or window, ${placedWith}, so the email you typed wasn't used — its confirmation goes to that address. Continue to pay it, or start a new cart to order with a different email.`;
}
