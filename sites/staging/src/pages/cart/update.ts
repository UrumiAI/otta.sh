/**
 * POST /cart/update — line-quantity shim over the plugin's public
 * `storefront/cart/lines/update` (target qty, not a delta). The
 * `idempotencyKey` arrives from the form — minted per rendered cart-page
 * form — and is forwarded verbatim; never invented here.
 */
import {
	CART_LINE_MAX_QTY,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	type CartLineMutationRouteResult,
	type CartLineWire,
} from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import {
	clearCartCookie,
	currentCartId,
	failureToken,
	QTY_TOO_LARGE,
	routeDispatcher,
	seeOther,
} from "../../lib/cart-actions.js";
import {
	busyResponse,
	dispatchOttaRoute,
	formPositiveInt,
	formString,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../lib/otta-api.js";

export const POST: APIRoute = async (context) => {
	// CSRF: src/middleware.ts has already refused a cross-site POST (ADR-0006).
	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();
	const lineId = formString(form.get("lineId"));
	const qty = formPositiveInt(form.get("qty"));
	const idempotencyKey = formString(form.get("idempotencyKey"));

	if (lineId === undefined || qty === undefined || idempotencyKey === undefined) {
		return new Response("Bad request: lineId, qty and idempotencyKey are required", {
			status: 400,
		});
	}

	// Over the cap: the plugin's own QTY_TOO_LARGE, answered without the
	// dispatch; the copy names the limit (QA U-6).
	if (qty > CART_LINE_MAX_QTY) return seeOther(context, "/cart", QTY_TOO_LARGE);

	const cartId = currentCartId(context);
	if (cartId === undefined) return seeOther(context, "/cart");

	const result = await dispatchOttaRoute<CartLineMutationRouteResult<{ line: CartLineWire }>>(
		routeDispatcher(context),
		STOREFRONT_CART_LINE_UPDATE_ROUTE,
		{ cartId, lineId, qty, idempotencyKey },
		context.url,
	);

	// Still busy after dispatch's one retry: 503, not a generic "went wrong".
	if (isBusyResult(result)) return busyResponse("/cart");
	if (result === null || !result.ok) {
		const token = failureToken(result);
		if (token === "CART_NOT_FOUND") clearCartCookie(context);
		return seeOther(context, "/cart", token);
	}

	return seeOther(context, "/cart");
};
