/**
 * Friendly copy for the `?error=<TOKEN>` shoppers can land on (item 2 —
 * raw error tokens shown to shoppers). Every `failureToken`/route result the
 * `/cart/*` endpoints and the PDP page can currently put on the query string
 * — the plugin's own (`OUT_OF_STOCK`, `CART_NOT_FOUND`, …), the site's own
 * (`SERVICE_UNAVAILABLE`, `cart-actions.ts`), and item 3's new
 * (`PRODUCT_NOT_FOUND`/`PRODUCT_UNAVAILABLE`) — maps to a human sentence
 * here. The raw token STAYS in the URL (`?error=OUT_OF_STOCK`) and in
 * `console.error` logs for debugging; only the on-page text changes.
 *
 * `MESSAGES` is a `Record<string, string>` with a generic fallback for any
 * unmapped/future token — defense in depth, so a raw machine token is never
 * rendered even if a new one is introduced later and someone forgets this
 * file.
 */
const GENERIC_FALLBACK = "Something went wrong — please try again shortly.";

const MESSAGES: Record<string, string> = {
	OUT_OF_STOCK: "Sorry, that item is out of stock.",
	CART_NOT_FOUND: "Your cart could not be found — it may have expired.",
	LINE_NOT_FOUND: "That cart item could not be found — it may have already been removed.",
	CART_CHECKED_OUT: "This cart has already been checked out.",
	LINE_CHECKED_OUT: "That item has already been checked out.",
	HOLD_EXPIRED: "Your hold on that item expired — please try again.",
	SKU_MISMATCH: "That item could not be added — please refresh the page and try again.",
	// The INVALID_*/RENDER_FAILED/SERVICE_UNAVAILABLE cluster: none of these
	// are shopper-actionable specifics, so they share the generic copy.
	INVALID_INPUT: GENERIC_FALLBACK,
	INVALID_CART_ID: GENERIC_FALLBACK,
	INVALID_CURRENCY: GENERIC_FALLBACK,
	RENDER_FAILED: GENERIC_FALLBACK,
	SERVICE_UNAVAILABLE: GENERIC_FALLBACK,
	// Item 3 — bogus SKU/productId rejection tokens (cart-actions.ts).
	PRODUCT_NOT_FOUND: "That product couldn't be found — please refresh the page and try again.",
	PRODUCT_UNAVAILABLE: "That product couldn't be found — please refresh the page and try again.",
};

/** Never returns the raw token, `undefined`, or an empty string — an
 *  unrecognized token (including `""`) falls back to the generic copy. */
export function cartErrorMessage(token: string): string {
	return MESSAGES[token] ?? GENERIC_FALLBACK;
}
