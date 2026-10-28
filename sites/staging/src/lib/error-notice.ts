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
/** The cart page's refusal notice (`CartModel.errorMessage`). */
export const CART_ERROR_ID = "cart-error";
/** The product page's refusal notice (`ProductContentModel.errorMessage`). */
export const PRODUCT_ERROR_ID = "product-error";

/** The page's title, led by "Error: " while it shows a refusal. */
export function errorTitle(title: string, hasError: boolean): string {
	return hasError ? `Error: ${title}` : title;
}
