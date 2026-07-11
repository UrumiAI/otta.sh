/**
 * POST /cart/add — the add-to-cart shim (ADR-0003): validates the form,
 * ensures a cart (setting the plugin's cookie descriptor on THIS
 * response), and proxies to the plugin's public
 * `storefront/cart/lines/add`.
 *
 * The `idempotencyKey` arrives FROM THE FORM — minted per rendered PDP by
 * the plugin's add-to-cart slot — and is forwarded verbatim; this endpoint
 * never invents one (a double-submit must replay, not duplicate). A
 * missing key is a 400, mirroring the plugin route's own input guard.
 */
import {
	STOREFRONT_CART_LINE_ADD_ROUTE,
	type CartLineMutationRouteResult,
	type CartLineWire,
} from "@urumi/plugin";
import type { APIRoute } from "astro";
import {
	clearCartCookie,
	ensureCartId,
	failureToken,
	routeDispatcher,
	seeOther,
	SERVICE_UNAVAILABLE,
} from "../../lib/cart-actions.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
import {
	dispatchUrumiRoute,
	formPositiveInt,
	formString,
	safeReturnPath,
} from "../../lib/urumi-api.js";

export const POST: APIRoute = async (context) => {
	// CSRF first: emdash disables Astro's checkOrigin; the shim enforces
	// its own origin check (origin-guard.ts, ADR-0004).
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	const form = await context.request.formData();
	const sku = formString(form.get("sku"));
	const qty = formPositiveInt(form.get("qty")) ?? 1;
	const idempotencyKey = formString(form.get("idempotencyKey"));
	const returnTo = safeReturnPath(form.get("returnTo"), "/products");

	if (sku === undefined || idempotencyKey === undefined) {
		return new Response("Bad request: sku and idempotencyKey are required", { status: 400 });
	}

	const handler = routeDispatcher(context);
	const cartId = await ensureCartId(context, handler);
	if (cartId === undefined) {
		return seeOther(context, returnTo, SERVICE_UNAVAILABLE);
	}

	const result = await dispatchUrumiRoute<CartLineMutationRouteResult<{ line: CartLineWire }>>(
		handler,
		STOREFRONT_CART_LINE_ADD_ROUTE,
		{ cartId, sku, qty, idempotencyKey },
		context.url,
	);

	if (result === null || !result.ok) {
		const token = failureToken(result);
		// A stale cookie pointing at a vanished cart: drop it so the next
		// add mints a fresh cart instead of failing forever.
		if (token === "CART_NOT_FOUND") clearCartCookie(context);
		return seeOther(context, returnTo, token);
	}

	return seeOther(context, "/cart");
};
