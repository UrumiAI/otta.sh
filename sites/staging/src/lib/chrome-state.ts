/**
 * The header's shopper state: the cart count on every storefront page (QA U-14),
 * read by `layouts/Storefront.astro` for a theme whose chrome opts in
 * (`ThemeModule.chrome.shopperState`). Its companion, whether the shopper is
 * signed in, is `lib/account.ts`'s `signedInEmail` — of which the chrome gets only
 * the yes/no, never the address.
 *
 * CACHING. A count is one visitor's, so it is read only when the request carries
 * that visitor's cart cookie, and the middleware sends every HTML page rendered
 * for such a request `private, no-store` and out of the route cache. A visitor
 * with no cart cookie costs nothing here and gets a header with no count, which
 * is safe to store (middleware.ts).
 *
 * FAIL SOFT, like the bag (`lib/bag.ts`): chrome decorates a page that has its
 * own job, so a busy, failed or vanished read is simply "no count" — never an
 * error page, never a 503, and never retried.
 */
import {
	CART_COOKIE_NAME,
	STOREFRONT_CART_READ_ROUTE,
	totalQty,
	type CartReadRouteResult,
} from "@otta-sh/plugin";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { isCartTerminal } from "./cart-view.js";
import { dispatchOttaRouteOnce } from "./otta-api.js";

export interface CartCountRequest {
	cookies: { get(name: string): { value: string } | undefined };
	locals: Parameters<typeof getPublicPluginApiRouteHandler>[0];
	url: URL;
}

/**
 * Units in the visitor's cart, or `null` for "draw no badge": no cart cookie (no
 * dispatch at all), an empty cart, a checked-out one (its lines are the order's
 * now), a vanished one, or a read that did not answer cleanly.
 */
export async function readCartCount(request: CartCountRequest): Promise<number | null> {
	const cartId = request.cookies.get(CART_COOKIE_NAME)?.value;
	if (cartId === undefined || cartId.length === 0) return null;
	let result: CartReadRouteResult | null;
	try {
		result = await dispatchOttaRouteOnce<CartReadRouteResult>(
			getPublicPluginApiRouteHandler(request.locals),
			STOREFRONT_CART_READ_ROUTE,
			{ cartId },
			request.url,
		);
	} catch (cause) {
		console.error("[site-staging] header cart count read threw:", cause);
		return null;
	}
	if (result === null || !result.ok || isCartTerminal(result.cart.state)) return null;
	const count = totalQty(result.cart);
	return count > 0 ? count : null;
}
