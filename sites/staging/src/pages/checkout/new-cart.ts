/**
 * POST /checkout/new-cart — the way out of the dead-cart trap.
 *
 * Once a cart is `checked_out` it never returns to `active`, and `expireOrders`
 * does not reset it. So a buyer who abandons payment and comes back after the
 * 15-minute TTL holds a cart that can produce no new order: a same-key replay
 * returns the EXPIRED order (`clientAction: none`), and a different key hits
 * `CART_CHECKED_OUT`. Bounded — the sweep resolves the underlying order — but
 * the buyer still needs a door. This is it.
 *
 * It clears **both** cookies. Clearing only `otta_cart` would leave a spent
 * client secret sitting in the browser for the rest of the hold, pointing at an
 * order the buyer has just walked away from.
 *
 * A POST, not a link: a GET-reachable state change is fired by same-site link
 * prefetching and by crawlers. (It is *not* fired by a cross-site `<img>`,
 * which would carry no `SameSite=Lax` cookie in the first place — and the
 * origin guard rejects a cross-site form POST regardless.)
 *
 * Anything smarter — reactivating a `checked_out` cart — is a domain change and
 * belongs in its own PR.
 */
import type { APIRoute } from "astro";
import { clearCartCookie, seeOther } from "../../lib/cart-actions.js";
import { clearCheckoutCookie } from "../../lib/checkout-cookie.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";

export const POST: APIRoute = (context) => {
	// CSRF first — a forged cross-site POST must not be able to bin someone's
	// cart. Nothing is cleared before this returns.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	clearCartCookie(context);
	clearCheckoutCookie(context.cookies);

	return seeOther(context, "/products");
};
