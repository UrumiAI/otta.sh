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
 * IT STOPS THE OLD ORDER FIRST (QA2 X4). The control says it clears any
 * payment still in progress, and clearing cookies alone did not: the order the
 * cart became stayed pending, its stock held, its PaymentIntent payable from
 * another tab. So before anything is cleared, the cart cookie (the possession
 * proof) is handed to `storefront/order/abandon`, which cancels that order if it
 * is still unpaid — releasing its stock and making its intent due for withdrawal
 * at once. If that cannot be confirmed (busy, unreachable), NOTHING is cleared
 * and /cart says so: dropping the cookies would leave the order running with the
 * shopper's only handle on it gone.
 *
 * Anything smarter — reactivating a `checked_out` cart — is a domain change and
 * belongs in its own PR.
 */
import {
	CART_COOKIE_NAME,
	STOREFRONT_ORDER_ABANDON_ROUTE,
	type OrderAbandonRouteResult,
} from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { clearCartCookie, seeOther, withoutReferrer } from "../../lib/cart-actions.js";
import { clearCheckoutCookie } from "../../lib/checkout-cookie.js";
import { clearCheckoutDraft } from "../../lib/checkout-draft.js";
import { dispatchOttaRoute } from "../../lib/otta-api.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";

export const POST: APIRoute = async (context) => {
	// CSRF first — a forged cross-site POST must not be able to bin someone's
	// cart, or cancel its order. Nothing is cleared before this returns.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return withoutReferrer(forbidden);

	const cartId = context.cookies.get(CART_COOKIE_NAME)?.value;
	if (cartId !== undefined && cartId.length > 0) {
		const abandoned = await dispatchOttaRoute<OrderAbandonRouteResult>(
			getPublicPluginApiRouteHandler(context.locals),
			STOREFRONT_ORDER_ABANDON_ROUTE,
			{ cartId },
			context.url,
		);
		// INVALID_INPUT is a cookie that cannot name a cart, so it names no order
		// either: nothing to stop. Anything else that is not a definite answer
		// leaves everything as it was.
		const settled =
			abandoned !== null &&
			(abandoned.ok || ("error" in abandoned && abandoned.error === "INVALID_INPUT"));
		if (!settled) {
			return withoutReferrer(seeOther(context, "/cart?error=NEW_CART_NOT_CLEARED"));
		}
	}

	clearCartCookie(context);
	clearCheckoutCookie(context.cookies);
	clearCheckoutDraft(context.cookies);

	// Posted from /checkout, whose URL may hold a coupon: the GET this 303
	// starts must not carry it as its Referer (see `withoutReferrer`).
	return withoutReferrer(seeOther(context, "/products"));
};
