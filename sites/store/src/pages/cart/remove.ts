/**
 * POST /cart/remove — line-removal shim over the plugin's public
 * `storefront/cart/lines/remove`. The `idempotencyKey` arrives from the
 * form — minted per rendered cart-page form — and is forwarded verbatim;
 * never invented here.
 */
import {
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	type CartLineRemoveRouteResult,
} from "@urumi.ai/otta-plugin";
import type { APIRoute } from "astro";
import {
	clearCartCookieIfBad,
	currentCartId,
	failureToken,
	routeDispatcher,
	seeOther,
} from "../../lib/cart-actions.js";
import {
	busyResponse,
	dispatchOttaRoute,
	formString,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../lib/otta-api.js";
import { CART_ERROR_ID } from "../../lib/error-notice.js";

export const POST: APIRoute = async (context) => {
	// CSRF: src/middleware.ts has already refused a cross-site POST (ADR-0006).
	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();
	const lineId = formString(form.get("lineId"));
	const idempotencyKey = formString(form.get("idempotencyKey"));

	if (lineId === undefined || idempotencyKey === undefined) {
		return new Response("Bad request: lineId and idempotencyKey are required", { status: 400 });
	}

	const cartId = currentCartId(context);
	if (cartId === undefined) return seeOther(context, "/cart");

	const result = await dispatchOttaRoute<CartLineRemoveRouteResult>(
		routeDispatcher(context),
		STOREFRONT_CART_LINE_REMOVE_ROUTE,
		{ cartId, lineId, idempotencyKey },
		context.url,
	);

	// Still busy after dispatch's one retry: 503, not a generic "went wrong".
	if (isBusyResult(result)) return busyResponse("/cart");
	if (result === null || !result.ok) {
		const token = failureToken(result);
		clearCartCookieIfBad(context, token);
		return seeOther(context, "/cart", token, CART_ERROR_ID);
	}

	return seeOther(context, "/cart");
};
