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
import type { APIContext, APIRoute } from "astro";
import {
	currentCartId,
	failureToken,
	routeDispatcher,
	seeOther,
	withoutReferrer,
} from "../../lib/cart-actions.js";
import { checkoutStashTotal, setCheckoutCookie } from "../../lib/checkout-cookie.js";
import {
	checkoutPath,
	placeFailurePath,
	readCouponCode,
	shapedDestination,
	type CheckoutUrlSelection,
} from "../../lib/checkout-selection.js";
import { isPlausibleEmail, normalizeBuyerRef } from "../../lib/email.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
import { STRIPE_PUBLISHABLE_KEY } from "../../lib/stripe-config.js";
import { busyResponse, dispatchOttaRoute, formString, isBusyResult } from "../../lib/otta-api.js";
import { isCodeShapedRegion } from "@otta-sh/plugin";

/** The site's own token for a form-level email reject — never reaches the
 *  service, which would happily accept the value (`schemas.ts` has no regex). */
const INVALID_EMAIL = "INVALID_EMAIL";
const INVALID_SHIPPING_ADDRESS = "INVALID_SHIPPING_ADDRESS";
const STRIPE_NOT_CONFIGURED = "STRIPE_NOT_CONFIGURED";

const SHIPPING_REGION_CODE_REQUIRED = "SHIPPING_REGION_CODE_REQUIRED";

/** ADR-0009's ship-to, as the form names them. The TYPED fields always decide
 *  all-or-nothing; `country` joins them only where the buyer types it too. */
const TYPED_ADDRESS_FIELDS = ["name", "line1", "city", "postalCode"] as const;
const OPTIONAL_ADDRESS_FIELDS = ["line2", "phone"] as const;

/** Two letters — the SHAPE of an ISO 3166-1 alpha-2 code (ADR-0021). */
const COUNTRY_SHAPE = /^[A-Za-z]{2}$/;

type AddressResult =
	| { ok: true; address: Record<string, string> | undefined }
	/** `partial`: the destination itself is fine — only typed fields are
	 *  missing — so the redirect keeps it rather than making the buyer choose
	 *  their delivery again. */
	| { ok: false; error: string; partial: boolean };

/**
 * Read the ship-to block. Three outcomes, and the middle one matters:
 *  - every counted field blank ⇒ ABSENT (whether the order may go without one
 *    is the plugin's call: a cart that ships, in a store with zones, is
 *    refused MISSING_SHIPPING_ADDRESS);
 *  - PARTIALLY filled ⇒ a validation reject, never a silently truncated
 *    snapshot: an order that quietly loses half its delivery address is
 *    unfulfillable and immutable;
 *  - fully filled ⇒ the snapshot, trimmed.
 *
 * WHICH fields count depends on the page (ADR-0021). On a ZONED store's review
 * (`addressMode=zoned`) the country and region are HIDDEN — the destination the
 * totals were priced for — so they are always "filled" and must not make a
 * blank address look partial: only the typed fields count, and the hidden pair
 * joins them. On a page with no zones the country is a select the buyer fills
 * in, and it counts like any typed field.
 *
 * Codes are checked by SHAPE here, never dispatched malformed: a country that is
 * not two letters is INVALID_SHIPPING_ADDRESS, a region that is not a code
 * SHIPPING_REGION_CODE_REQUIRED. Whether they are REAL codes is the plugin's.
 */
function readShippingAddress(form: FormData, zoned: boolean): AddressResult {
	const typed = TYPED_ADDRESS_FIELDS.map((field) => [field, formString(form.get(field))] as const);
	const country = formString(form.get("country"));
	const region = formString(form.get("region"));
	const counted = zoned ? typed : [...typed, ["country", country] as const];
	const filled = counted.filter(([, value]) => value !== undefined);
	if (filled.length === 0) return { ok: true, address: undefined };
	if (filled.length !== counted.length || country === undefined) {
		return { ok: false, error: INVALID_SHIPPING_ADDRESS, partial: true };
	}
	if (!COUNTRY_SHAPE.test(country)) {
		return { ok: false, error: INVALID_SHIPPING_ADDRESS, partial: false };
	}
	if (region !== undefined && !isCodeShapedRegion(region)) {
		return { ok: false, error: SHIPPING_REGION_CODE_REQUIRED, partial: false };
	}

	const address: Record<string, string> = {};
	for (const [field, value] of typed) address[field] = value!;
	address["country"] = country;
	if (region !== undefined) address["region"] = region;
	for (const field of OPTIONAL_ADDRESS_FIELDS) {
		const value = formString(form.get(field));
		if (value !== undefined) address[field] = value;
	}
	return { ok: true, address };
}

/** Every response — above all the 303 to /checkout/pay — is sent
 *  `Referrer-Policy: no-referrer`, so the redirected GET does not carry this
 *  POST's `/checkout?coupon=…` Referer into `document.referrer` (see
 *  `withoutReferrer`). */
export const POST: APIRoute = async (context) => withoutReferrer(await place(context));

async function place(context: APIContext): Promise<Response> {
	// CSRF FIRST — before the body is even read. emdash force-disables Astro's
	// checkOrigin and its replacement covers only /_emdash/api/* (ADR-0006), so
	// without this a cross-site form POST could create a real order.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	const form = await context.request.formData();

	// The coupon the review priced, echoed by the form (#305). Read FIRST, so
	// every redirect below can carry it back: it is not personal data. Trimmed,
	// never case-folded (lookup is case-sensitive); blank ⇒ OMITTED, never `""`,
	// which the commerce client would refuse. A code over the plugin's cap is
	// refused here as what it is — no such coupon — without a dispatch.
	const coupon = readCouponCode(formString(form.get("couponCode")));
	if (coupon.rejected !== undefined) {
		return context.redirect(placeFailurePath(coupon.rejected.reason, {}), 303);
	}
	const couponCode = coupon.couponCode;
	// The method the review priced (a radio, or the lone option it preselected),
	// echoed as a hidden field; forwarded only when present. The zone is NEVER
	// read: the plugin derives it from the address (ADR-0021).
	const shippingMethodId = formString(form.get("shippingMethodId"));
	// A zoned store's review carries the destination it priced as hidden
	// fields (see readShippingAddress).
	const zoned = formString(form.get("addressMode")) === "zoned";
	// What a failure redirect may carry back — never an address field: only the
	// coupon, the method and, from a zoned page, the coarse destination.
	const selection: CheckoutUrlSelection = {
		couponCode,
		shippingMethodId,
		// Shape-checked like the delivery form's GET: a crafted hidden field
		// never reaches the redirect URL.
		...(zoned
			? shapedDestination(formString(form.get("country")), formString(form.get("region")))
			: {}),
	};

	// No publishable key ⇒ NO ORDER (§1.7). The review page already hides the
	// button, but this is the server-side half of that promise: creating an
	// order would hold stock for 15 minutes against a payment that structurally
	// cannot happen. (A malformed key never reaches here — it fails the build.)
	if (STRIPE_PUBLISHABLE_KEY === undefined) {
		return context.redirect(placeFailurePath(STRIPE_NOT_CONFIGURED, selection), 303);
	}

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
		// secret. The buyer re-enters; the PII does not travel. (The coupon does:
		// it is not personal data.)
		// COST, stated plainly: this check runs BEFORE readShippingAddress, so a
		// mistyped email discards any typed shipping address too — not just the
		// email. The alternative that would preserve both without a URL is
		// re-rendering from the POST response instead of 303-ing, which was not
		// taken because it breaks POST-redirect-GET (reload re-POSTs). Revisit if
		// the re-entry cost shows up in real use.
		return context.redirect(placeFailurePath(INVALID_EMAIL, selection), 303);
	}

	// From the form, forwarded verbatim — never invented here (see module doc).
	const idempotencyKey = formString(form.get("idempotencyKey"));
	if (idempotencyKey === undefined) {
		return new Response("Bad request: idempotencyKey is required", { status: 400 });
	}

	const shipping = readShippingAddress(form, zoned);
	if (!shipping.ok) {
		return context.redirect(
			shipping.partial
				? checkoutPath({ ...selection, error: shipping.error })
				: placeFailurePath(shipping.error, selection),
			303,
		);
	}

	const result = await dispatchOttaRoute<CheckoutPlaceRouteResult>(
		routeDispatcher(context),
		STOREFRONT_CHECKOUT_PLACE_ROUTE,
		{
			cartId,
			buyerRef: email,
			idempotencyKey,
			...(couponCode !== undefined ? { couponCode } : {}),
			...(shippingMethodId !== undefined ? { shippingMethodId } : {}),
			...(shipping.address !== undefined ? { shippingAddress: shipping.address } : {}),
		},
		context.url,
	);

	// Busy. NOT auto-retried (not on otta-api.ts's retry allowlist — this is the
	// route that mints a payment intent). The 503 invites the buyer to try again:
	// a reload re-posts the same `checkout:<cartId>` key, and since #337 a
	// same-key replay finishes a partial first attempt rather than skipping it.
	if (isBusyResult(result)) return busyResponse("/checkout");
	if (result === null || !result.ok) {
		// Back to /checkout, which can explain and let the buyer retry — the cart
		// is still theirs, and for CART_CHECKED_OUT the page offers a way out. The
		// part of the selection a refusal blames is dropped; the rest is kept.
		return context.redirect(placeFailurePath(failureToken(result), selection), 303);
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
}
