/**
 * POST /cart/remove — line-removal shim over the plugin's public
 * `storefront/cart/lines/remove`. The `idempotencyKey` arrives from the
 * form — minted per rendered cart-page form — and is forwarded verbatim;
 * never invented here.
 */
import { STOREFRONT_CART_LINE_REMOVE_ROUTE, type CartLineRemoveRouteResult } from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import {
	clearCartCookie,
	currentCartId,
	failureToken,
	routeDispatcher,
	seeOther,
} from "../../lib/cart-actions.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
import { dispatchOttaRoute, formString } from "../../lib/otta-api.js";

export const POST: APIRoute = async (context) => {
	// CSRF first: emdash disables Astro's checkOrigin; the shim enforces
	// its own origin check (origin-guard.ts, ADR-0006).
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	const form = await context.request.formData();
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

	if (result === null || !result.ok) {
		const token = failureToken(result);
		if (token === "CART_NOT_FOUND") clearCartCookie(context);
		return seeOther(context, "/cart", token);
	}

	return seeOther(context, "/cart");
};
