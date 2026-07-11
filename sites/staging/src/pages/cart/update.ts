/**
 * POST /cart/update — line-quantity shim over the plugin's public
 * `storefront/cart/lines/update` (target qty, not a delta). The
 * `idempotencyKey` arrives from the form — minted per rendered cart-page
 * form — and is forwarded verbatim; never invented here.
 */
import {
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	type CartLineMutationRouteResult,
	type CartLineWire,
} from "@urumi/plugin";
import type { APIRoute } from "astro";
import {
	clearCartCookie,
	currentCartId,
	failureToken,
	routeDispatcher,
	seeOther,
} from "../../lib/cart-actions.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
import { dispatchUrumiRoute, formPositiveInt, formString } from "../../lib/urumi-api.js";

export const POST: APIRoute = async (context) => {
	// CSRF first: emdash disables Astro's checkOrigin; the shim enforces
	// its own origin check (origin-guard.ts, ADR-0006).
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	const form = await context.request.formData();
	const lineId = formString(form.get("lineId"));
	const qty = formPositiveInt(form.get("qty"));
	const idempotencyKey = formString(form.get("idempotencyKey"));

	if (lineId === undefined || qty === undefined || idempotencyKey === undefined) {
		return new Response("Bad request: lineId, qty and idempotencyKey are required", {
			status: 400,
		});
	}

	const cartId = currentCartId(context);
	if (cartId === undefined) return seeOther(context, "/cart");

	const result = await dispatchUrumiRoute<CartLineMutationRouteResult<{ line: CartLineWire }>>(
		routeDispatcher(context),
		STOREFRONT_CART_LINE_UPDATE_ROUTE,
		{ cartId, lineId, qty, idempotencyKey },
		context.url,
	);

	if (result === null || !result.ok) {
		const token = failureToken(result);
		if (token === "CART_NOT_FOUND") clearCartCookie(context);
		return seeOther(context, "/cart", token);
	}

	return seeOther(context, "/cart");
};
