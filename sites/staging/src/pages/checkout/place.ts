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
 * The `idempotencyKey` is `checkout:<cartId>` — STABLE per cart, unlike the
 * cart forms' fresh-per-render keys, so a double-click, a reload or a
 * back-then-forward replays into the same order and the same PaymentIntent
 * instead of minting a second order the `CART_CHECKED_OUT` fence would reject.
 *
 * The form still carries it (the plugin's summary route derives it for the
 * review page), but it is no longer TRUSTED: the key dispatched is derived here
 * from the cart the COOKIE names, and a form whose key names any other cart is
 * refused as a stale page (QA T1-10). Forwarded verbatim, a crafted
 * `checkout:<another cart>` bound that key to the poster's own cart, and the
 * other cart's real checkout then failed IDEMPOTENCY_KEY_REUSED for good. The
 * form's key is kept as a CHECK rather than ignored because it is the page's
 * statement of which cart was reviewed: a tab left open on cart A, posted after
 * the cookie moved to cart B, must not place B's order against A's totals.
 * The plugin's place route enforces the same rule (it is public, so it cannot
 * rely on this page); checking here as well answers the stale page before any
 * dispatch, and the plugin's own CHECKOUT_STALE reads as the same notice.
 */
import {
	checkoutIdempotencyKey,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	type CheckoutPlaceRouteResult,
} from "@otta-sh/plugin";
import type { APIContext, APIRoute } from "astro";
import { currentSessionToken } from "../../lib/account.js";
import {
	currentCartId,
	failureToken,
	routeDispatcher,
	seeOther,
	withoutReferrer,
} from "../../lib/cart-actions.js";
import { checkoutStashTotal, setCheckoutCookie } from "../../lib/checkout-cookie.js";
import {
	clearCheckoutDraft,
	draftValuesFromForm,
	writeCheckoutDraft,
	type DraftField,
	type DraftFieldError,
} from "../../lib/checkout-draft.js";
import {
	checkoutPath,
	deliveryDiffers,
	deliveryUpdatePath,
	isCouponFailure,
	placeFailurePath,
	readCouponCode,
	shapedDestination,
	type CheckoutUrlSelection,
} from "../../lib/checkout-selection.js";
import { ORDER_PLACED_OTHER_EMAIL } from "../../lib/checkout-review.js";
import { isPlausibleEmail, normalizeBuyerRef } from "../../lib/email.js";
import { STRIPE_PUBLISHABLE_KEY } from "../../lib/stripe-config.js";
import {
	busyResponse,
	dispatchOttaRoute,
	formString,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../lib/otta-api.js";
import { COUNTRY_CODES, isCodeShapedRegion, ORDER_ADDRESS_MAX_LENGTHS } from "@otta-sh/plugin";
import { subdivisionOptions } from "@otta-sh/plugin/subdivisions";
import {
	DELIVERY_REGION_COUNTRY_FIELD,
	REGION_COUNTRY_FIELD,
	regionListIsStale,
} from "../../lib/regions.js";

/** The site's own token for a form-level email reject — never reaches the
 *  service, which would happily accept the value (`schemas.ts` has no regex). */
const INVALID_EMAIL = "INVALID_EMAIL";
const INVALID_SHIPPING_ADDRESS = "INVALID_SHIPPING_ADDRESS";
const STRIPE_NOT_CONFIGURED = "STRIPE_NOT_CONFIGURED";
/** The site's own token for a review page placed for a cart the cookie no
 *  longer names (see the module doc). */
const CHECKOUT_STALE = "CHECKOUT_STALE";
/** An explicit Apply of the code already applied (it never places). */
const COUPON_ALREADY_APPLIED = "COUPON_ALREADY_APPLIED";

const SHIPPING_REGION_CODE_REQUIRED = "SHIPPING_REGION_CODE_REQUIRED";
/** The site's own: the address's country changed since its state/province list
 *  was rendered, so the review comes back with the new country's list instead
 *  of placing (the region pick list has no client JS to swap it in place). */
const REGION_LIST_UPDATED = "REGION_LIST_UPDATED";

/** ADR-0009's ship-to, as the form names them. The TYPED fields always decide
 *  all-or-nothing; `country` joins them only where the buyer types it too. */
const TYPED_ADDRESS_FIELDS = ["name", "line1", "city", "postalCode"] as const;
const OPTIONAL_ADDRESS_FIELDS = ["line2", "phone"] as const;

/** Two letters — the SHAPE of an ISO 3166-1 alpha-2 code (ADR-0021). */
const COUNTRY_SHAPE = /^[A-Za-z]{2}$/;

type FieldErrors = Partial<Record<DraftField, DraftFieldError>>;

type AddressResult =
	| { ok: true; address: Record<string, string> | undefined }
	/** `partial`: the destination itself is fine — only typed fields are
	 *  missing — so the redirect keeps it rather than making the buyer choose
	 *  their delivery again. `fields`: which fields the refusal is about, so the
	 *  review can say so beside each one (QA U-1). */
	| { ok: false; error: string; partial: boolean; fields: FieldErrors };

/**
 * Read the ship-to block. Three outcomes, and the middle one matters:
 *  - every counted field blank ⇒ ABSENT (whether the order may go without one
 *    is the plugin's call: a cart that ships, in a store with zones — or any
 *    cart, when the store's Stripe account is in India (issue #382) — is
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
function readShippingAddress(
	form: FormData,
	zoned: boolean,
	options: { dropRegion?: boolean } = {},
): AddressResult {
	const typed = TYPED_ADDRESS_FIELDS.map((field) => [field, formString(form.get(field))] as const);
	const country = formString(form.get("country"));
	const region = options.dropRegion === true ? undefined : formString(form.get("region"));
	const counted = zoned ? typed : [...typed, ["country", country] as const];
	const filled = counted.filter(([, value]) => value !== undefined);
	if (filled.length === 0) return { ok: true, address: undefined };
	if (filled.length !== counted.length || country === undefined) {
		const fields: FieldErrors = {};
		for (const [field, value] of counted) if (value === undefined) fields[field] = "missing";
		if (country === undefined) fields.country = "missing";
		return { ok: false, error: INVALID_SHIPPING_ADDRESS, partial: true, fields };
	}
	// Shaped like a code but naming no country ("ZZ"): refused here with the
	// field marked (QA2 edge H) — dispatched, the plugin's refusal named none.
	if (!COUNTRY_SHAPE.test(country) || !COUNTRY_CODES.has(country.toUpperCase())) {
		return {
			ok: false,
			error: INVALID_SHIPPING_ADDRESS,
			partial: false,
			fields: { country: "invalid" },
		};
	}
	if (region !== undefined && !isCodeShapedRegion(region)) {
		return {
			ok: false,
			error: SHIPPING_REGION_CODE_REQUIRED,
			partial: false,
			fields: { region: "invalid" },
		};
	}
	// Over the domain's own per-field bound (measured after trimming, as the
	// domain measures it) is the ADDRESS error it is, refused here. Dispatched,
	// it failed the plugin's bound as the generic INVALID_INPUT — "Something
	// went wrong" for a buyer whose street name was simply too long (QA U-6).
	// The inputs carry the same numbers as `maxlength`; this is for whatever
	// gets past them.
	const tooLong: FieldErrors = {};
	for (const field of [...TYPED_ADDRESS_FIELDS, ...OPTIONAL_ADDRESS_FIELDS]) {
		const value = formString(form.get(field));
		if (value !== undefined && value.length > ORDER_ADDRESS_MAX_LENGTHS[field]) {
			tooLong[field] = "too_long";
		}
	}
	if (Object.keys(tooLong).length > 0) {
		return { ok: false, error: INVALID_SHIPPING_ADDRESS, partial: false, fields: tooLong };
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

/** A hidden field's raw value, or `undefined` when the form does not carry it
 *  at all — `""` (no country chosen yet) is a value here, unlike `formString`. */
function presentField(form: FormData, name: string): string | undefined {
	const value = form.get(name);
	return typeof value === "string" ? value : undefined;
}

/** The required ship-to fields the buyer left blank — for the plugin's
 *  MISSING_SHIPPING_ADDRESS, which names none. */
function blankRequiredFields(form: FormData, zoned: boolean): FieldErrors {
	const fields: FieldErrors = {};
	const required: readonly DraftField[] = zoned
		? TYPED_ADDRESS_FIELDS
		: [...TYPED_ADDRESS_FIELDS, "country"];
	for (const field of required) {
		if (formString(form.get(field)) === undefined) fields[field] = "missing";
	}
	return fields;
}

/** Every response — above all the 303 to /checkout/pay — is sent
 *  `Referrer-Policy: no-referrer`, so the redirected GET does not carry this
 *  POST's `/checkout?coupon=…` Referer into `document.referrer` (see
 *  `withoutReferrer`). */
export const POST: APIRoute = async (context) => withoutReferrer(await place(context));

async function place(context: APIContext): Promise<Response> {
	// CSRF: src/middleware.ts has already refused a cross-site POST (ADR-0006),
	// before this reads the body, so a forged form cannot create a real order.
	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();

	// What the buyer typed, kept across every refusal below (QA U-1) — in the
	// draft cookie, never in the redirect URL (see lib/checkout-draft.ts).
	const draftValues = draftValuesFromForm(form);
	// The address block's state/province list belongs to the country it was
	// rendered for (`regionCountry`, see UPDATE ADDRESS below). Once the country
	// has changed, a region picked from that list is dropped — from the draft
	// every redirect writes, and from the address placed.
	const addressCountry = formString(form.get("country"));
	const addressListStale =
		formString(form.get("addressMode")) !== "zoned" &&
		regionListIsStale(presentField(form, REGION_COUNTRY_FIELD), addressCountry);
	if (addressListStale) delete draftValues.region;
	const refuse = (
		path: string,
		error: string | undefined,
		extra: { fields?: FieldErrors; coupon?: string | undefined } = {},
	): Response => {
		writeCheckoutDraft(context.cookies, {
			values: draftValues,
			errors: extra.fields ?? {},
			...(error !== undefined ? { error } : {}),
			...(extra.coupon !== undefined ? { coupon: extra.coupon } : {}),
		});
		return context.redirect(path, 303);
	};

	// The coupon the review priced, echoed by the form (#305). Read FIRST, so
	// every redirect below can carry it back: it is not personal data. Trimmed,
	// never case-folded here (the plugin's lookup ignores case, ADR-0025); blank ⇒ OMITTED, never `""`,
	// which the commerce client would refuse. A code over the plugin's cap is
	// refused here as what it is — no such coupon — without a dispatch.
	const coupon = readCouponCode(formString(form.get("couponCode")));
	if (coupon.rejected !== undefined) {
		return refuse(placeFailurePath(coupon.rejected.reason, {}), coupon.rejected.reason);
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

	// APPLY / REMOVE COUPON (QA U-1). These buttons submit THIS form (they sit
	// beside the coupon field, `form="checkout-place"`, without browser
	// validation), so changing the coupon no longer drops everything typed below
	// it: the typed values go into the draft and the review re-renders priced
	// with the new code. An explicit Apply NEVER places — the applied code again
	// is answered "already applied".
	//
	// ENTER (review round 1). Enter in a details field submits through the form's
	// first submit button, a hidden `intent=enter` (CheckoutView.astro), never
	// through Apply. It applies a code typed into the box that differs from the
	// applied one — unless it is the code just REFUSED, put back for correcting
	// (`refusedCoupon`), which would only loop on the same refusal; re-prices a
	// changed delivery (below); and otherwise places.
	const intent = formString(form.get("intent"));
	const typedCoupon = readCouponCode(formString(form.get("coupon")));
	const typedCode = typedCoupon.couponCode ?? typedCoupon.rejected?.code;
	if (intent === "remove-coupon") {
		return refuse(checkoutPath({ ...selection, couponCode: undefined }), undefined);
	}
	if (intent === "apply-coupon") {
		if (typedCode !== undefined && typedCode === couponCode) {
			return refuse(
				checkoutPath({ ...selection, error: COUPON_ALREADY_APPLIED }),
				COUPON_ALREADY_APPLIED,
			);
		}
		return refuse(checkoutPath({ ...selection, couponCode: typedCode }), undefined);
	}
	if (
		intent === "enter" &&
		typedCode !== couponCode &&
		typedCode !== undefined &&
		typedCode !== formString(form.get("refusedCoupon"))
	) {
		return refuse(checkoutPath({ ...selection, couponCode: typedCode }), undefined);
	}

	// UPDATE DELIVERY (QA U-1): like Apply, a submit of THIS form, so changing
	// where the order goes keeps everything typed. And the safety net: any other
	// submit (Enter in a field goes through Apply, the form's default button)
	// whose delivery fields differ from the ones the totals were priced with is
	// re-priced, never placed at the old price.
	//
	// The region PICK LIST is rendered for one country (`deliveryRegionCountry`):
	// a region picked from it is never sent for another country the buyer has
	// since chosen — the same code (`01`) means a different place there.
	const deliveryCountry = formString(form.get("deliveryCountry"));
	const delivery = {
		country: deliveryCountry,
		region: regionListIsStale(presentField(form, DELIVERY_REGION_COUNTRY_FIELD), deliveryCountry)
			? undefined
			: formString(form.get("deliveryRegion")),
		method: formString(form.get("deliveryMethod")),
		fromCountry: formString(form.get("fromCountry")),
		fromRegion: formString(form.get("fromRegion")),
	};
	if (
		intent === "update-delivery" ||
		(zoned &&
			deliveryDiffers(delivery, {
				country: formString(form.get("country")),
				region: formString(form.get("region")),
				method: shippingMethodId,
			}))
	) {
		return refuse(deliveryUpdatePath(delivery, couponCode), undefined);
	}

	// UPDATE ADDRESS — the address block's own country (a page with no delivery
	// block). Its state/province list is rendered for the country the page knew
	// (`regionCountry`); the Update button beside the country re-renders the
	// review with the new country's list, keeping everything typed. A region
	// picked for the old country is dropped, never sent as the new one's.
	if (intent === "update-address") {
		return refuse(checkoutPath(selection), undefined);
	}
	// And the safety net. The state/province list on the page belongs to the
	// country it was rendered for — "" before any was chosen, with no list at all.
	// A place whose country has changed since then never goes ahead blind: when
	// the new country HAS subdivisions, the review comes back once with its list
	// shown (and marked), so a buyer always sees it before an order is placed —
	// a first-time no-JS buyer included. When a region was posted for another
	// country, it comes back too (it never silently loses the region and places,
	// as main refused such a region rather than placing). After that one round
	// trip the list matches the country and the region stays optional.
	if (
		addressListStale &&
		(formString(form.get("region")) !== undefined ||
			subdivisionOptions(addressCountry ?? "").length > 0)
	) {
		return refuse(checkoutPath({ ...selection, error: REGION_LIST_UPDATED }), REGION_LIST_UPDATED, {
			fields: subdivisionOptions(addressCountry ?? "").length > 0 ? { region: "invalid" } : {},
		});
	}

	// No publishable key ⇒ NO ORDER (§1.7). The review page already hides the
	// button, but this is the server-side half of that promise: creating an
	// order would hold stock for 15 minutes against a payment that structurally
	// cannot happen. (A malformed key never reaches here — it fails the build.)
	if (STRIPE_PUBLISHABLE_KEY === undefined) {
		return refuse(placeFailurePath(STRIPE_NOT_CONFIGURED, selection), STRIPE_NOT_CONFIGURED);
	}

	const cartId = currentCartId(context);
	if (cartId === undefined) return seeOther(context, "/cart");

	// The email is the buyerRef — the ONLY strictly-required field at the wire.
	const rawEmail = form.get("email");
	const email = typeof rawEmail === "string" ? normalizeBuyerRef(rawEmail) : "";
	if (!isPlausibleEmail(email)) {
		// Nothing typed is echoed back through the redirect: carrying a home
		// address and an email through a query string puts them in browser
		// history, in the Referer of every subresource and in Cloudflare's access
		// logs — the exact exposure ADR-0012 §6 argues against for the client
		// secret. They travel in the draft cookie instead (QA U-1), and the address
		// is checked here too, so every field that needs fixing is marked at once.
		const address = readShippingAddress(form, zoned, { dropRegion: addressListStale });
		return refuse(placeFailurePath(INVALID_EMAIL, selection), INVALID_EMAIL, {
			fields: { email: "invalid", ...(address.ok ? {} : address.fields) },
		});
	}

	// Derived from the COOKIE's cart; the form's copy is only checked against it
	// (see module doc). Never taken from the form as-is.
	const formKey = formString(form.get("idempotencyKey"));
	if (formKey === undefined) {
		return new Response("Bad request: idempotencyKey is required", { status: 400 });
	}
	const idempotencyKey = checkoutIdempotencyKey(cartId);
	if (formKey !== idempotencyKey) {
		return refuse(placeFailurePath(CHECKOUT_STALE, selection), CHECKOUT_STALE);
	}

	const shipping = readShippingAddress(form, zoned, { dropRegion: addressListStale });
	if (!shipping.ok) {
		return refuse(
			shipping.partial
				? checkoutPath({ ...selection, error: shipping.error })
				: placeFailurePath(shipping.error, selection),
			shipping.error,
			{ fields: shipping.fields },
		);
	}

	// The signed-in shopper's session, if any. The plugin route is cookie-blind
	// (ADR-0003), so the page reads its own cookie and passes the bearer on; the
	// PLUGIN decides what it means — the order is theirs from birth only when this
	// email is their account's own, else it is a guest order like any other.
	// Without it, an order placed signed in was missing from "Your orders" until
	// the shopper signed in again.
	const sessionToken = currentSessionToken(context.cookies);

	const result = await dispatchOttaRoute<CheckoutPlaceRouteResult>(
		routeDispatcher(context),
		STOREFRONT_CHECKOUT_PLACE_ROUTE,
		{
			cartId,
			buyerRef: email,
			idempotencyKey,
			...(sessionToken !== undefined ? { sessionToken } : {}),
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
	if (isBusyResult(result)) {
		writeCheckoutDraft(context.cookies, { values: draftValues, errors: {} });
		return busyResponse("/checkout");
	}
	if (result === null || !result.ok) {
		// Back to /checkout, which can explain and let the buyer retry — the cart
		// is still theirs, and for CART_CHECKED_OUT the page offers a way out. The
		// part of the selection a refusal blames is dropped; the rest is kept, and
		// so is everything typed (the draft). A refused coupon is dropped from the
		// URL but comes back into its field, to be corrected.
		const token = failureToken(result);
		return refuse(placeFailurePath(token, selection), token, {
			fields:
				token === SHIPPING_REGION_CODE_REQUIRED
					? { region: "invalid" }
					: token === "MISSING_SHIPPING_ADDRESS"
						? blankRequiredFields(form, zoned)
						: {},
			coupon: isCouponFailure(token) ? couponCode : undefined,
		});
	}

	// Placed: the typed values have done their job.
	clearCheckoutDraft(context.cookies);

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
	/* The order's email, masked: the pay page states where the confirmation goes
	   (QA2 X2), as the resume path's stash already did. */
	const emailHint =
		typeof result.buyerRefHint === "string" && result.buyerRefHint.length > 0
			? result.buyerRefHint
			: undefined;
	setCheckoutCookie(context.cookies, {
		orderId: result.orderId,
		clientSecret: result.clientAction.clientSecret,
		...(total !== undefined ? { total } : {}),
		...(emailHint !== undefined ? { emailHint } : {}),
	});
	/* ANOTHER TAB placed this cart's order first, with another email (QA2 X2): the
	   same-key place replayed that order, which keeps its own email. Never on to
	   the pay page as if the typed email were used: back to the locked review,
	   which names the order's (masked) address and offers to pay it or start a
	   new cart. Stashed above like any place, so "Continue to payment" pays it. */
	if (result.emailMatches === false) {
		return seeOther(context, "/checkout", ORDER_PLACED_OTHER_EMAIL);
	}
	return seeOther(context, "/checkout/pay");
}
