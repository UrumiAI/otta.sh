/**
 * `storefront/shopper-state` — the storefront header's two facts: the visitor's
 * cart (state and unit count) and whether their session is live (QA U-12, U-14).
 *
 * The header asks on every uncached page a shopper with a cart or a session
 * loads, so this route is built for cost: at most ONE cart-document read and ONE
 * session-document read (`getShopperState`), no kv, no customer read, no price
 * join, no hold expiry. That is also why it constructs the in-process client
 * directly rather than through `makeCommerceClient`, which resolves the payment
 * gateways from kv on every call — a read path that takes no payment needs none.
 *
 * It answers `signedIn` as yes/no only — never who — and treats every input it
 * cannot use (absent, not a string, oversized, not an id) as absent: the header
 * then draws nothing, which is what a guest sees anyway.
 */
import { isIdToken } from "../commerce/commerce-input.js";
import { InProcessCommerceClient } from "../commerce/in-process-commerce-client.js";
import type { ShopperStateWire } from "../product-commerce/commerce-client.js";
import type { RouteHandler } from "../types.js";
import { isNonEmptyString, MAX_SESSION_TOKEN_LENGTH } from "./account-routes.js";
import { renderGuard, type RenderGuardFailure } from "./pdp-route.js";

export const STOREFRONT_SHOPPER_STATE_ROUTE = "storefront/shopper-state";

export interface ShopperStateInput {
	cartId?: unknown;
	sessionToken?: unknown;
}

export type ShopperStateResult = ({ ok: true } & ShopperStateWire) | RenderGuardFailure;

export function createShopperStateHandler(): RouteHandler<ShopperStateInput> {
	return (routeCtx, ctx): Promise<ShopperStateResult> =>
		renderGuard(STOREFRONT_SHOPPER_STATE_ROUTE, async () => {
			const { cartId, sessionToken } = routeCtx.input;
			const usableCart = isNonEmptyString(cartId) && isIdToken(cartId) ? cartId : undefined;
			const usableSession =
				isNonEmptyString(sessionToken) && sessionToken.length <= MAX_SESSION_TOKEN_LENGTH
					? sessionToken
					: undefined;
			if (usableCart === undefined && usableSession === undefined) {
				return { ok: true as const, cart: null, signedIn: false };
			}
			const state = await new InProcessCommerceClient(ctx).getShopperState({
				...(usableCart !== undefined ? { cartId: usableCart } : {}),
				...(usableSession !== undefined ? { sessionToken: usableSession } : {}),
			});
			return { ok: true as const, ...state };
		});
}
