/**
 * Nav helpers for the site chrome (src/layouts/Base.astro).
 *
 * The primary menu is CMS-authored, so the layout cannot assume any particular
 * spelling of a URL: it has to RECOGNISE the cart entry rather than be told
 * which one it is. That recognition is the sort of thing that breaks quietly —
 * the badge just stops appearing — so it lives here as a plain function the
 * test can import and exercise directly.
 */

/**
 * Does this menu URL point at the cart? Tolerates the query string, the
 * fragment and a trailing slash, all of which are legal things for an editor
 * to type into the menu.
 */
export function isCartLink(url: string): boolean {
	const path = url.split(/[?#]/)[0] ?? "";
	return path.replace(/\/+$/, "") === "/cart";
}

/**
 * The accessible name for the cart badge. The badge renders as "(3)", which a
 * screen reader announces as "left paren three right paren"; this is what it
 * says instead.
 */
export function cartCountLabel(count: number): string {
	return count === 1 ? "1 item" : `${count} items`;
}
