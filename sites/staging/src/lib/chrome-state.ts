/**
 * The header's shopper state (QA U-12, U-14): the cart count on every storefront
 * page and whether the shopper is signed in, read by `layouts/Storefront.astro`
 * for a theme whose chrome opts in (`ThemeModule.chrome.shopperState`).
 *
 * COST. It is asked on every uncached page a shopper with a cart or a session
 * loads, so it is ONE dispatch of the lean `storefront/shopper-state` route — at
 * most one cart-document read and one session-document read on the plugin side,
 * no price join, no customer read — and dispatched ONCE, without the BUSY retry.
 * Not the full cart read (`storefront/cart/read`) and not `account/me`.
 *
 * CACHING. Each fact is asked only when the request carries the cookie it
 * depends on (no cookie ⇒ no dispatch), and the middleware sends every HTML page
 * rendered for such a request `private, no-store` and out of the route cache.
 *
 * FAIL SOFT, like the bag (`lib/bag.ts`): chrome decorates a page that has its
 * own job, so any answer but a clean one is "draw nothing" — never an error page,
 * never a 503.
 */
import {
	CART_COOKIE_NAME,
	SESSION_COOKIE_NAME,
	STOREFRONT_SHOPPER_STATE_ROUTE,
	type ShopperStateResult,
} from "@otta-sh/plugin";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { isCartTerminal } from "./cart-view.js";
import { dispatchOttaRouteOnce } from "./otta-api.js";

export interface ShopperStateRequest {
	cookies: { get(name: string): { value: string } | undefined };
	locals: Parameters<typeof getPublicPluginApiRouteHandler>[0];
	url: URL;
}

export interface ShopperState {
	/** Units to badge the cart link with, or `null` for no badge. */
	cartCount: number | null;
	/** A live session — yes or no, never who. */
	signedIn: boolean;
}

/**
 * The ONE badge rule, for every page (/cart included): a count only when there is
 * something in the cart. An empty cart and "no cart read" both draw the bare link,
 * so the header does not say "(0)" on one page and nothing on the next.
 */
export function chromeCartCount(count: number | null): number | null {
	return count !== null && count > 0 ? count : null;
}

const NOTHING: ShopperState = { cartCount: null, signedIn: false };

/** What the header draws. `want` names the facts the page did not already know;
 *  only those whose cookie is present are asked for, in ONE dispatch. */
export async function readShopperState(
	request: ShopperStateRequest,
	want: { count: boolean; signedIn: boolean },
): Promise<ShopperState> {
	const cartId = want.count ? request.cookies.get(CART_COOKIE_NAME)?.value : undefined;
	const sessionToken = want.signedIn ? request.cookies.get(SESSION_COOKIE_NAME)?.value : undefined;
	const input = {
		...(cartId !== undefined && cartId.length > 0 ? { cartId } : {}),
		...(sessionToken !== undefined && sessionToken.length > 0 ? { sessionToken } : {}),
	};
	if (Object.keys(input).length === 0) return NOTHING;
	let result: ShopperStateResult | null;
	try {
		result = await dispatchOttaRouteOnce<ShopperStateResult>(
			getPublicPluginApiRouteHandler(request.locals),
			STOREFRONT_SHOPPER_STATE_ROUTE,
			input,
			request.url,
		);
	} catch (cause) {
		console.error("[site-staging] header shopper-state read threw:", cause);
		return NOTHING;
	}
	if (result === null || !result.ok) return NOTHING;
	const cart = result.cart;
	return {
		cartCount: cart === null || isCartTerminal(cart.state) ? null : chromeCartCount(cart.count),
		signedIn: result.signedIn === true,
	};
}
