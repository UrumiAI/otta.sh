/**
 * A refusal that lands after a redirect (#603) — `POST` → 303 → the page again
 * with `?error=…`. The reload keeps the page's title and puts focus at the top,
 * so without these a screen-reader user hears the same page come back and
 * cannot tell the order was not placed or the line not added.
 *
 * Three pieces, none of them JavaScript (the checkout ships no script for it):
 *  - {@link errorTitle}: the document title leads with "Error: ";
 *  - the notice's id below, on an element with `role="alert"` and
 *    `tabindex="-1"` — a theme view that renders the page's `errorMessage` must
 *    render it in exactly that element (a theme may restyle it, never rename it);
 *  - the failure redirect carries that id as its fragment, so the browser
 *    scrolls to the notice and starts sequential focus from it.
 *
 * Pure: the routes and the views both import it, so neither can drift from the
 * other's spelling.
 */

/** The checkout review's refusal notice (`CheckoutModel.errorMessage`). */
export const CHECKOUT_ERROR_ID = "checkout-error";
/** The checkout's coupon refusal, beside the coupon field. A coupon refused AT
 *  PLACE is said here instead of in {@link CHECKOUT_ERROR_ID}. */
export const COUPON_ERROR_ID = "coupon-error";
/** The checkout's destination refusal, in the delivery block. A refusal the
 *  summary repeats for the destination is said here instead. */
export const DELIVERY_ERROR_ID = "delivery-error";
/** The checkout's delivery block itself — rendered whenever the review shows
 *  delivery, so around {@link DELIVERY_ERROR_ID} whenever that renders. */
export const DELIVERY_BLOCK_ID = "delivery";
/** The cart page's refusal notice (`CartModel.errorMessage`). */
export const CART_ERROR_ID = "cart-error";
/** The product page's refusal notice (`ProductContentModel.errorMessage`). */
export const PRODUCT_ERROR_ID = "product-error";

/** The page's title, led by "Error: " while it shows a refusal. */
export function errorTitle(title: string, hasError: boolean): string {
	return hasError ? `Error: ${title}` : title;
}

/** What else the checkout review is saying when it renders a refused `token`. */
export interface CheckoutNoticeContext {
	/** The coupon refused at place comes back into its field, refusal beside it. */
	placeCouponRefused: boolean;
	/** The reason the review's own summary refuses the destination with, if any. */
	destinationReason: string | undefined;
}

/**
 * Which of the checkout's notices says a refused `token` — the ONE decision
 * `pages/checkout/index.astro` renders by (the page-level notice only when this
 * is {@link CHECKOUT_ERROR_ID}) and `place.ts` names its redirect's fragment by.
 * Said once: a coupon refused at place is said beside the coupon; a refusal the
 * summary repeats for the destination (or a list update beside one) in the
 * delivery block.
 */
export function checkoutNoticeId(token: string, context: CheckoutNoticeContext): string {
	if (context.placeCouponRefused) return COUPON_ERROR_ID;
	if (context.destinationReason !== undefined) {
		if (token === context.destinationReason || token === "REGION_LIST_UPDATED") {
			return DELIVERY_ERROR_ID;
		}
	}
	return CHECKOUT_ERROR_ID;
}

/** Destination refusals the review's summary refuses AGAIN, with the same
 *  reason, when the redirect keeps the buyer's country (`placeFailurePath`): the
 *  zone still does not match, and a region the zone needs is still missing. An
 *  INVALID_SHIPPING_ADDRESS is about the street address, which the summary does
 *  not price, so it is said on the page. */
const REPEATED_DESTINATION_REFUSALS: ReadonlySet<string> = new Set([
	"SHIPPING_ZONE_NOT_MATCHED",
	"SHIPPING_REGION_CODE_REQUIRED",
]);

/**
 * `place.ts`'s side of {@link checkoutNoticeId}: the notice the review will
 * render a refusal in, from what place itself knows — whether the refused
 * coupon rode the draft back (`kept.coupon`: a coupon refusal whose code the
 * draft carries, so the page puts it back into the field), and whether the
 * redirect kept a country for the summary to refuse again. place cannot run
 * the summary, so the destination half is the expected answer; a fragment
 * whose target is not on the page simply does nothing.
 *
 * REGION_LIST_UPDATED with a country kept is NOT predicted: the page says it
 * at the top, or — when the summary also refuses that destination (a store
 * zoned by state) — only in the delivery block. So it lands on the delivery
 * block itself ({@link DELIVERY_BLOCK_ID}), which holds the refreshed list and
 * renders in both cases on a page that shows delivery.
 */
export function placeRefusalNoticeId(
	token: string,
	kept: { coupon: boolean; country: boolean },
): string {
	if (token === "REGION_LIST_UPDATED" && kept.country) return DELIVERY_BLOCK_ID;
	return checkoutNoticeId(token, {
		placeCouponRefused: kept.coupon,
		destinationReason: kept.country && REPEATED_DESTINATION_REFUSALS.has(token) ? token : undefined,
	});
}
