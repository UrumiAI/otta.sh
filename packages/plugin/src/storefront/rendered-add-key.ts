/**
 * The add-to-cart key a product page RENDERS (issue #39), and how to recognise
 * one. Its own module so the view model that mints it and `cart/create`, which
 * refuses to be keyed on it, share one rule without importing each other.
 */

/**
 * The mark on every add-to-cart key the product view model renders (issue #39). A rendered key
 * belongs to the PAGE, and a shared cache may serve one rendered page to every
 * visitor, so it is not one visitor's secret: `cart/create` treats a marked key
 * as no key at all (see {@link isRenderedAddToCartKey}). The add-line routes
 * take it like any other key — it is well-formed text, far under the key ceiling.
 * The product page's script (ADR-0039) replaces it per submission with an
 * unmarked browser-minted key, which is what a create may be keyed on.
 */
export const RENDERED_ADD_TO_CART_KEY_PREFIX = "pdp:";

/** A fresh rendered add-to-cart key: the marker plus a UUID, per render. */
export function renderedAddToCartKey(): string {
	return `${RENDERED_ADD_TO_CART_KEY_PREFIX}${crypto.randomUUID()}`;
}

/** Whether `key` is one the product view model rendered — a key a page may have shown
 *  to many visitors, which must never key a cart create. */
export function isRenderedAddToCartKey(key: string): boolean {
	return key.startsWith(RENDERED_ADD_TO_CART_KEY_PREFIX);
}
