/**
 * POST /checkout/update — the review page's "update delivery / apply coupon"
 * round trip (issue #305). No client JS: the buyer picks a country (and
 * region), a delivery method and/or a coupon, this endpoint stores the choice
 * in the `otta_checkout_selection` cookie, and 303s back to `GET /checkout`,
 * whose summary then shows the zone's methods and the updated totals.
 *
 * Nothing here prices anything or talks to the plugin: the summary does, and
 * derives the shipping zone from the country/region itself. This endpoint only
 * remembers what was chosen, after dropping anything malformed.
 *
 * `action=remove-coupon` clears the coupon and keeps the rest.
 */
import type { APIRoute } from "astro";
import { seeOther } from "../../lib/cart-actions.js";
import { normalizeSelection, setCheckoutSelection } from "../../lib/checkout-selection.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";

export const POST: APIRoute = async (context) => {
	// CSRF first, like every other state-changing POST on this site (ADR-0006).
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	const form = await context.request.formData();
	const removeCoupon = form.get("action") === "remove-coupon";
	const selection = normalizeSelection({
		country: form.get("country"),
		region: form.get("region"),
		shippingMethodId: form.get("shippingMethodId"),
		couponCode: removeCoupon ? null : form.get("couponCode"),
	});
	setCheckoutSelection(context.cookies, selection);
	return seeOther(context, "/checkout");
};
