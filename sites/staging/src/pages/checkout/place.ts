/**
 * POST /checkout/place — the order-creation shim (ADR-0003): validate the
 * form, dispatch the plugin's public `storefront/checkout/place`, stash the
 * client secret and the order's total in a first-party cookie, 303 to the
 * payment step.
 *
 * This is the step boundary the design turns on. The Payment Element cannot
 * mount without a client secret, and the client secret does not exist until the
 * order is created — so order creation is necessarily its own POST. Splitting
 * it here also means the order (which reserves stock for 15 minutes) is created
 * only after the buyer has committed contact details, not on page view.
 *
 * The `idempotencyKey` arrives FROM THE FORM — `checkout:<cartId>`, derived by
 * the plugin's summary route — and is forwarded verbatim; this endpoint never
 * invents one. Unlike the cart forms' fresh-per-render keys it is STABLE per
 * cart, so a double-click, a reload or a back-then-forward replays into the
 * same order and the same PaymentIntent instead of minting a second order the
 * `CART_CHECKED_OUT` fence would then reject.
 */
import { STOREFRONT_CHECKOUT_PLACE_ROUTE, type CheckoutPlaceRouteResult } from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { currentCartId, failureToken, routeDispatcher, seeOther } from "../../lib/cart-actions.js";
import { checkoutStashTotal, setCheckoutCookie } from "../../lib/checkout-cookie.js";
import { isPlausibleEmail, normalizeBuyerRef } from "../../lib/email.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
import { STRIPE_PUBLISHABLE_KEY } from "../../lib/stripe-config.js";
import { dispatchOttaRoute, formString } from "../../lib/otta-api.js";

/** The site's own token for a form-level email reject — never reaches the
 *  service, which would happily accept the value (`schemas.ts` has no regex). */
const INVALID_EMAIL = "INVALID_EMAIL";
const INVALID_SHIPPING_ADDRESS = "INVALID_SHIPPING_ADDRESS";
const STRIPE_NOT_CONFIGURED = "STRIPE_NOT_CONFIGURED";

/** ADR-0009's ship-to, as the form names them. `line2`/`region`/`phone` are
 *  optional; the five required fields are all-or-nothing (see below). */
const REQUIRED_ADDRESS_FIELDS = ["name", "line1", "city", "postalCode", "country"] as const;
const OPTIONAL_ADDRESS_FIELDS = ["line2", "region", "phone"] as const;

type AddressResult =
	| { ok: true; address: Record<string, string> | undefined }
	| { ok: false; error: string };

/**
 * Read the ship-to block. Three outcomes, and the middle one matters:
 *  - every required field blank ⇒ ABSENT (capture is optional this slice,
 *    ADR-0009 — the buyer simply did not fill it in);
 *  - PARTIALLY filled ⇒ a validation reject, never a silently truncated
 *    snapshot: an order that quietly loses half its delivery address is
 *    unfulfillable and immutable;
 *  - fully filled ⇒ the snapshot, trimmed.
 */
function readShippingAddress(form: FormData): AddressResult {
	const required = REQUIRED_ADDRESS_FIELDS.map(
		(field) => [field, formString(form.get(field))] as const,
	);
	const filled = required.filter(([, value]) => value !== undefined);
	if (filled.length === 0) return { ok: true, address: undefined };
	if (filled.length !== required.length) return { ok: false, error: INVALID_SHIPPING_ADDRESS };

	const address: Record<string, string> = {};
	for (const [field, value] of required) address[field] = value!;
	for (const field of OPTIONAL_ADDRESS_FIELDS) {
		const value = formString(form.get(field));
		if (value !== undefined) address[field] = value;
	}
	return { ok: true, address };
}

export const POST: APIRoute = async (context) => {
	// CSRF FIRST — before the body is even read. emdash force-disables Astro's
	// checkOrigin and its replacement covers only /_emdash/api/* (ADR-0006), so
	// without this a cross-site form POST could create a real order.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	// No publishable key ⇒ NO ORDER (§1.7). The review page already hides the
	// button, but this is the server-side half of that promise: creating an
	// order would hold stock for 15 minutes against a payment that structurally
	// cannot happen. (A malformed key never reaches here — it fails the build.)
	if (STRIPE_PUBLISHABLE_KEY === undefined) {
		return seeOther(context, "/checkout", STRIPE_NOT_CONFIGURED);
	}

	const form = await context.request.formData();

	const cartId = currentCartId(context);
	if (cartId === undefined) return seeOther(context, "/cart");

	// The email is the buyerRef — the ONLY strictly-required field at the wire.
	const rawEmail = form.get("email");
	const email = typeof rawEmail === "string" ? normalizeBuyerRef(rawEmail) : "";
	if (!isPlausibleEmail(email)) {
		// DELIBERATE deviation from the plan's "other form values preserved":
		// nothing typed is echoed back through the redirect. Carrying a home
		// address and an email through a query string puts them in browser
		// history, in the Referer of every subresource and in Cloudflare's access
		// logs — the exact exposure ADR-0012 §6 argues against for the client
		// secret. The buyer re-enters; the PII does not travel.
		// COST, stated plainly: this check runs BEFORE readShippingAddress, so a
		// mistyped email discards any typed shipping address too — not just the
		// email. The alternative that would preserve both without a URL is
		// re-rendering from the POST response instead of 303-ing, which was not
		// taken because it breaks POST-redirect-GET (reload re-POSTs). Revisit if
		// the re-entry cost shows up in real use.
		return seeOther(context, "/checkout", INVALID_EMAIL);
	}

	// From the form, forwarded verbatim — never invented here (see module doc).
	const idempotencyKey = formString(form.get("idempotencyKey"));
	if (idempotencyKey === undefined) {
		return new Response("Bad request: idempotencyKey is required", { status: 400 });
	}

	const shipping = readShippingAddress(form);
	if (!shipping.ok) return seeOther(context, "/checkout", shipping.error);

	const result = await dispatchOttaRoute<CheckoutPlaceRouteResult>(
		routeDispatcher(context),
		STOREFRONT_CHECKOUT_PLACE_ROUTE,
		{
			cartId,
			buyerRef: email,
			idempotencyKey,
			...(shipping.address !== undefined ? { shippingAddress: shipping.address } : {}),
		},
		context.url,
	);

	if (result === null || !result.ok) {
		// Back to /checkout, which can explain and let the buyer retry — the cart
		// is still theirs, and for CART_CHECKED_OUT the page offers a way out.
		return seeOther(context, "/checkout", failureToken(result));
	}

	// A replay of an order that has already LEFT pending: no intent was minted
	// and none is needed. Straight to the order — treating this as an error
	// would strand a buyer whose order is already PAID.
	if (result.alreadyPlaced || result.clientAction.kind !== "stripe_client_secret") {
		return seeOther(context, `/orders/${encodeURIComponent(result.orderId)}`);
	}

	// The total is PROJECTED through the stash's own validator, not spread. Two
	// reasons, both about this being the payment path:
	//  - the route's `total` also carries the minor-unit `amount`, and the cookie
	//    deliberately holds no money NUMBER (see checkout-cookie.ts);
	//  - the dispatcher hands back parsed JSON that `CheckoutPlaceRouteResult`
	//    only ASSERTS the shape of. A reply without a total must cost the button
	//    its amount, never 500 an order whose stock is already held and whose
	//    intent already exists.
	const total = checkoutStashTotal(result.total);
	setCheckoutCookie(context.cookies, {
		orderId: result.orderId,
		clientSecret: result.clientAction.clientSecret,
		...(total !== undefined ? { total } : {}),
	});
	return seeOther(context, "/checkout/pay");
};
