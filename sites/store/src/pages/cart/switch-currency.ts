/**
 * POST /cart/switch-currency — the way out for a cart left in the OLD currency
 * after the operator switched the store currency (#440; the cart page offers it
 * when the cart read carries `staleCurrency`).
 *
 * Asks the plugin's `storefront/cart/create` for the cookie cart's
 * stale-currency REPLACEMENT: the plugin checks the cart is active and really is
 * in another currency than the saved store currency, releases every hold it
 * has, and answers a new, empty cart in the store currency — keyed on the old
 * cart server-side, so a double submit lands in the same new cart. This shim
 * applies that cart's cookie, drops the checkout stash (it belonged to the old
 * cart) and sends the shopper to the products to add their items again. The
 * checkout DRAFT (the email and address they typed) is theirs and is kept.
 *
 * CSRF: src/middleware.ts has already refused a cross-site POST (ADR-0006).
 */
import { STOREFRONT_CART_CREATE_ROUTE, type CartCreateRouteResult } from "@urumi.ai/otta-plugin";
import type { APIRoute } from "astro";
import { applyCartCookie } from "../../lib/cart-cookie.js";
import {
	clearCartCookieIfBad,
	currentCartId,
	failureToken,
	routeDispatcher,
	seeOther,
} from "../../lib/cart-actions.js";
import { clearCheckoutCookie } from "../../lib/checkout-cookie.js";
import { busyResponse, dispatchOttaRoute, isBusyResult } from "../../lib/otta-api.js";
import { CART_ERROR_ID } from "../../lib/error-notice.js";

export const POST: APIRoute = async (context) => {
	const cartId = currentCartId(context);
	if (cartId === undefined) return seeOther(context, "/cart");

	const replaced = await dispatchOttaRoute<CartCreateRouteResult>(
		routeDispatcher(context),
		STOREFRONT_CART_CREATE_ROUTE,
		{ replacesStaleCurrencyCartId: cartId },
		context.url,
	);
	if (isBusyResult(replaced)) return busyResponse("/cart");
	if (replaced !== null && replaced.ok) {
		applyCartCookie(context.cookies, replaced.cookie);
		clearCheckoutCookie(context.cookies);
		return seeOther(context, "/products");
	}

	const token = failureToken(replaced);
	// Already in the store currency (or the operator switched back): nothing to
	// replace, and the cart is fine — the page simply shows it.
	if (token === "CART_CURRENCY_CURRENT") return seeOther(context, "/cart");
	clearCartCookieIfBad(context, token);
	return seeOther(context, "/cart", token, CART_ERROR_ID);
};
